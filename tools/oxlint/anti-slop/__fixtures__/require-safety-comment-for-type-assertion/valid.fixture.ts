declare const value: string | number

// SAFETY: The fixture models a value validated by an external boundary.
const name = value as string

export { name }
