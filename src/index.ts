export function hello(name = 'Bun') {
  return `Hello, ${name}!`
}

if (import.meta.main) {
  console.info(hello())
}
