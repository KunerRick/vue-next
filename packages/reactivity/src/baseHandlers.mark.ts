import {
  reactive,
  readonly,
  toRaw,
  ReactiveFlags,
  Target,
  readonlyMap,
  reactiveMap,
  shallowReactiveMap,
  shallowReadonlyMap
} from './reactive'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import {
  track,
  trigger,
  ITERATE_KEY,
  pauseTracking,
  resetTracking
} from './effect'
import {
  isObject,
  hasOwn,
  isSymbol,
  hasChanged,
  isArray,
  isIntegerKey,
  extend,
  makeMap
} from '@vue/shared'
import { isRef } from './ref'

const isNonTrackableKeys = /*#__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

const builtInSymbols = new Set(
  Object.getOwnPropertyNames(Symbol)
    .map(key => (Symbol as any)[key])
    .filter(isSymbol)
)

const get = /*#__PURE__*/ createGetter()
const shallowGet = /*#__PURE__*/ createGetter(false, true)
const readonlyGet = /*#__PURE__*/ createGetter(true)
const shallowReadonlyGet = /*#__PURE__*/ createGetter(true, true)

const arrayInstrumentations = /*#__PURE__*/ createArrayInstrumentations()

/**
 * 对数组的 'includes', 'indexOf', 'lastIndexOf' 以及 'push', 'pop', 'shift', 'unshift', 'splice'方法加入追踪，以便进行依赖收集
 *
 * @returns
 */
function createArrayInstrumentations() {
  const instrumentations: Record<string, Function> = {}
  // 装配对操作敏感的数组方法，以用于可能的响应式操作(尝试注释，还未发现需要用到的场景)
  // instrument identity-sensitive Array methods to account for possible reactive
  // values
  ;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
    // 这里的this是个伪参数，仅用于静态检查，属于ts的用法，参考 this参数：https://www.tslang.cn/docs/handbook/functions.html
    instrumentations[key] = function(this: unknown[], ...args: unknown[]) {
      // 转换为原始类型
      const arr = toRaw(this) as any
      // 对数组的每个元素进行追踪，为什么要在这三个方法里进行追踪？因为确实会依赖。依赖追踪是在get方法中进行的
      for (let i = 0, l = this.length; i < l; i++) {
        track(arr, TrackOpTypes.GET, i + '')
      }
      // we run the method using the original args first (which may be reactive)
      // 如果参数不是响应式的，这一步直接就会有结果
      const res = arr[key](...args)
      if (res === -1 || res === false) {
        // if that didn't work, run it again using raw values.
        // 以防参数是响应式的，再执行一次
        return arr[key](...args.map(toRaw))
      } else {
        return res
      }
    }
  })
  // instrument length-altering mutation methods to avoid length being tracked
  // 因为length的变化也会被侦听到，所以这些会改变数组长度的方法执行时，就不进行依赖追踪
  // which leads to infinite loops in some cases (#2137)
  ;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
    instrumentations[key] = function(this: unknown[], ...args: unknown[]) {
      pauseTracking()
      // 是因为此处的操作如果追踪的话，可能会死循环？ TODO:
      const res = (toRaw(this) as any)[key].apply(this, args)
      resetTracking()
      return res
    }
  })
  return instrumentations
}

/**
 * 创建 getter
 * @param isReadonly 是否只读，默认否
 * @param shallow 是否只处理第一层，默认否
 * @returns 所以返回的就是get函数，当key为
 * ReactiveFlags.IS_REACTIVE
 * ReactiveFlags.IS_READONLY
 * ReactiveFlags.RAW 这三种情况特殊处理。
 *
 */
function createGetter(isReadonly = false, shallow = false) {
  /**
   * 返回适用于 Reflect.get 的函数
   * @param target
   * @param key
   * @param receiver
   * @returns
   */
  return function get(target: Target, key: string | symbol, receiver: object) {
    // isReadonly 因闭包的机制，留存起来了
    // ReactiveFlags.IS_REACTIVE 值与 isReadonly互斥
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    } else if (
      key === ReactiveFlags.RAW &&
      receiver ===
        (isReadonly
          ? shallow
            ? shallowReadonlyMap
            : readonlyMap
          : shallow
            ? shallowReactiveMap
            : reactiveMap
        ).get(target)
    ) {
      /**
       * 获取原始对象。
       * 这个地方的get执行时，用于缓存的map中，一定有这个代理对象，所以根据 isReadonly 和 shallow 来拿到相应的缓存对象，再进而拿到 target 对象
       * 关于 receiver： 如果target对象中指定了getter，receiver则为getter调用时的this值,即当前的proxy对象
       */
      return target
    }

    // 判断目标对象是否是数组
    const targetIsArray = isArray(target)

    // 这里将数组的方法重写了一遍，用于反射调用，这里为什么要使用声明的方法？TODO:
    if (!isReadonly && targetIsArray && hasOwn(arrayInstrumentations, key)) {
      return Reflect.get(arrayInstrumentations, key, receiver)
    }

    // 其他的就是常规获取了
    const res = Reflect.get(target, key, receiver)

    // 当key 是 symbol类型时，特殊处理
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }

    // 如果时响应式的，执行track
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }

    // 如果只是浅处理，直接返回
    if (shallow) {
      return res
    }
    // 如果是ref对象，且不是数组或key不是整型，执行展开，返回value值
    if (isRef(res)) {
      // ref unwrapping - does not apply for Array + integer key.
      const shouldUnwrap = !targetIsArray || !isIntegerKey(key)
      return shouldUnwrap ? res.value : res
    }

    // 如果获取的值仍然是对象，则递归处理。TODO:待深究注释的含义
    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      return isReadonly ? readonly(res) : reactive(res)
    }
    return res
  }
}

const set = /*#__PURE__*/ createSetter()
const shallowSet = /*#__PURE__*/ createSetter(true)

function createSetter(shallow = false) {
  return function set(
    target: object,
    key: string | symbol,
    value: unknown,
    receiver: object
  ): boolean {
    let oldValue = (target as any)[key]
    if (!shallow) {
      // 转化为原始值
      value = toRaw(value)
      oldValue = toRaw(oldValue)
      // 这一步直接赋值，交给Ref对象内部的响应式机制处理
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        oldValue.value = value
        return true
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
    }

    const hadKey =
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)
    const result = Reflect.set(target, key, value, receiver)
    // don't trigger if target is something up in the prototype chain of original
    // 只触发当前对象，不管原型链上的target
    if (target === toRaw(receiver)) {
      if (!hadKey) {
        trigger(target, TriggerOpTypes.ADD, key, value)
        // 如果有这个key,并且发生了改变，才执行trigger
      } else if (hasChanged(value, oldValue)) {
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }
}

function deleteProperty(target: object, key: string | symbol): boolean {
  const hadKey = hasOwn(target, key)
  const oldValue = (target as any)[key]
  const result = Reflect.deleteProperty(target, key)
  if (result && hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}

function has(target: object, key: string | symbol): boolean {
  const result = Reflect.has(target, key)
  if (!isSymbol(key) || !builtInSymbols.has(key)) {
    track(target, TrackOpTypes.HAS, key)
  }
  return result
}

function ownKeys(target: object): (string | symbol)[] {
  track(target, TrackOpTypes.ITERATE, isArray(target) ? 'length' : ITERATE_KEY)
  return Reflect.ownKeys(target)
}

export const mutableHandlers: ProxyHandler<object> = {
  get,
  set,
  deleteProperty,
  has,
  ownKeys
}

export const readonlyHandlers: ProxyHandler<object> = {
  get: readonlyGet,
  set(target, key) {
    if (__DEV__) {
      console.warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  },
  deleteProperty(target, key) {
    if (__DEV__) {
      console.warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }
}

export const shallowReactiveHandlers = /*#__PURE__*/ extend(
  {},
  mutableHandlers,
  {
    get: shallowGet,
    set: shallowSet
  }
)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers = /*#__PURE__*/ extend(
  {},
  readonlyHandlers,
  {
    get: shallowReadonlyGet
  }
)
