import assert from 'node:assert/strict'
import test from 'node:test'
import {stripVTControlCharacters} from 'node:util'
import {grayText, greenText, rainbowText} from '../dist/console-style.js'

test('native console styles preserve text, whitespace, and Unicode characters', () => {
  const text = 'Open BMCLAPI 现代化'

  assert.equal(stripVTControlCharacters(greenText(text)), text)
  assert.equal(stripVTControlCharacters(grayText(text)), text)
  assert.equal(stripVTControlCharacters(rainbowText(text)), text)
})
