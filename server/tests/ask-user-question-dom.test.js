import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

function makeElement(tagName) {
  const listeners = new Map()
  return {
    tagName: tagName.toUpperCase(),
    className: '',
    children: [],
    dataset: {},
    style: {},
    hidden: false,
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    type: '',
    placeholder: '',
    appendChild(child) {
      this.children.push(child)
      child.parentNode = this
      return child
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(handler)
    },
    async emit(type, event = {}) {
      for (const handler of listeners.get(type) || []) await handler(event)
    },
  }
}

function findAll(node, predicate, acc = []) {
  if (predicate(node)) acc.push(node)
  for (const child of node.children || []) findAll(child, predicate, acc)
  return acc
}

let createAskUserQuestionBlock

before(async () => {
  global.document = {
    createElement: (tagName) => makeElement(tagName),
  }
  ;({ createAskUserQuestionBlock } = await import('../../public/js/claude-block-renderer/dom-render.js'))
})

describe('AskUserQuestion DOM block', () => {
  it('renders questions, other inputs, and submits the expected result shape', async () => {
    let submitted = null
    const block = createAskUserQuestionBlock({
      dialogId: 'dialog-1',
      payload: {
        questions: [
          {
            header: 'Features',
            question: 'Which features should we enable?',
            multiSelect: true,
            options: [
              { label: 'Search', description: 'Enable search' },
              { label: 'Diff', description: 'Enable diff' },
            ],
          },
          {
            header: 'Tone',
            question: 'Which tone should we use?',
            multiSelect: false,
            options: [
              { label: 'Formal', description: 'Keep it formal' },
              { label: 'Casual', description: 'Keep it casual' },
            ],
          },
        ],
      },
      onSubmit: async (result) => {
        submitted = result
        return true
      },
    })

    const questionSections = findAll(block.article, (node) => node.className === 'cbr-ask-question')
    assert.equal(questionSections.length, 2)

    const otherInputs = findAll(block.article, (node) => node.className === 'cbr-ask-other-input')
    assert.equal(otherInputs.length, 2)

    const checkboxes = findAll(block.article, (node) => node.className === 'cbr-ask-option-checkbox')
    checkboxes.find((node) => node.value === 'Search').checked = true
    checkboxes.find((node) => node.value === 'Diff').checked = true
    otherInputs[1].value = 'Playful'

    const form = findAll(block.article, (node) => node.className === 'cbr-ask-form')[0]
    await form.emit('submit', { preventDefault() {} })

    assert.deepEqual(submitted, {
      questions: [
        {
          header: 'Features',
          question: 'Which features should we enable?',
          multiSelect: true,
          options: [
            { label: 'Search', description: 'Enable search' },
            { label: 'Diff', description: 'Enable diff' },
          ],
        },
        {
          header: 'Tone',
          question: 'Which tone should we use?',
          multiSelect: false,
          options: [
            { label: 'Formal', description: 'Keep it formal' },
            { label: 'Casual', description: 'Keep it casual' },
          ],
        },
      ],
      answers: {
        'Which features should we enable?': 'Search, Diff',
        'Which tone should we use?': 'Playful',
      },
      response: 'Playful',
    })
  })
})
