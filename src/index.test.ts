import { describe, expect, test } from 'bun:test'
import { hello } from './index'

describe('hello', () => {
  test('defaults to Bun', () => {
    expect(hello()).toBe('Hello, Bun!')
  })

  test('accepts a name', () => {
    expect(hello('Andy')).toBe('Hello, Andy!')
  })
})
