import {styleText} from 'node:util'

const options = {validateStream: false} as const
const rainbowColors = ['red', 'yellow', 'green', 'blue', 'magenta'] as const

export function greenText(text: string): string {
  return styleText('green', text, options)
}

export function grayText(text: string): string {
  return styleText('gray', text, options)
}

export function rainbowText(text: string): string {
  let colorIndex = 0
  return Array.from(text, (character) => {
    if (/\s/u.test(character)) return character
    const color = rainbowColors[colorIndex % rainbowColors.length]
    colorIndex++
    return styleText(color, character, options)
  }).join('')
}
