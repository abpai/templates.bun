// Complexity exactly 10 (1 + 9 branches): the maximum passes.
export function classify(value: number) {
  if (value === 0) return 'zero'
  if (value === 1) return 'one'
  if (value === 2) return 'two'
  if (value === 3) return 'three'
  if (value === 4) return 'four'
  if (value === 5) return 'five'
  if (value === 6) return 'six'
  if (value === 7) return 'seven'
  if (value === 8) return 'eight'
  return 'many'
}

// Under the modified variant the whole switch counts once, so ten cases stay
// far below the maximum.
export function choose(value: number) {
  switch (value) {
    case 0:
      return 'zero'
    case 1:
      return 'one'
    case 2:
      return 'two'
    case 3:
      return 'three'
    case 4:
      return 'four'
    case 5:
      return 'five'
    case 6:
      return 'six'
    case 7:
      return 'seven'
    case 8:
      return 'eight'
    case 9:
      return 'nine'
    default:
      return 'many'
  }
}
