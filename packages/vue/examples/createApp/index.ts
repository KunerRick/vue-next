interface HostNode {
  [x: string]: unknown
}
interface M<OneNode = HostNode> {
  el: OneNode | null
}

let el: HostNode = {
  a: 'd',
  el: 'ss'
}

let b: M = {
  el: null
}

b.el = el

function testFunc(): void {}
