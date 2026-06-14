import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAskUserQuestionCancelledToolResult,
  buildAskUserQuestionResult,
  buildAskUserQuestionToolResult,
} from '../../public/js/claude-block-renderer/ask-user-question.js'

describe('AskUserQuestion result builder', () => {
  it('uses custom text as the single-select answer when provided', () => {
    const result = buildAskUserQuestionResult(
      {
        questions: [
          {
            header: 'Stack',
            question: 'Which stack should we use?',
            multiSelect: false,
            options: [
              { label: 'React', description: 'Use React' },
              { label: 'Vue', description: 'Use Vue' },
            ],
          },
        ],
      },
      [{ selectedLabels: ['React'], otherText: 'Svelte' }]
    )

    assert.equal(result.answers['Which stack should we use?'], 'Svelte')
    assert.equal(result.response, 'Svelte')
  })

  it('joins multi-select choices and custom text into one answer string', () => {
    const result = buildAskUserQuestionResult(
      {
        questions: [
          {
            header: 'Features',
            question: 'Which features do you want?',
            multiSelect: true,
            options: [
              { label: 'Search', description: 'Enable search' },
              { label: 'Export', description: 'Enable export' },
            ],
          },
        ],
      },
      [{ selectedLabels: ['Search', 'Export'], otherText: 'Audit log' }]
    )

    assert.equal(result.answers['Which features do you want?'], 'Search, Export, Audit log')
    assert.equal(result.response, 'Audit log')
  })

  it('throws when a required answer is missing', () => {
    assert.throws(
      () => buildAskUserQuestionResult(
        {
          questions: [
            {
              header: 'Flavor',
              question: 'Pick one?',
              multiSelect: false,
              options: [
                { label: 'Alpha', description: 'Use alpha' },
                { label: 'Beta', description: 'Use beta' },
              ],
            },
          ],
        },
        [{ selectedLabels: [], otherText: '' }]
      ),
      /Please answer/
    )
  })

  it('wraps answers into an MCP tool result payload', () => {
    const result = buildAskUserQuestionToolResult({
      questions: [
        {
          header: 'Flavor',
          question: 'Which option should we use?',
          multiSelect: false,
          options: [
            { label: 'Alpha', description: 'Use alpha' },
            { label: 'Beta', description: 'Use beta' },
          ],
        },
      ],
      answers: {
        'Which option should we use?': 'Beta',
      },
    })

    assert.equal(result.structuredContent.answers['Which option should we use?'], 'Beta')
    assert.match(result.content[0].text, /"Beta"/)
  })

  it('builds an error tool result for cancelled prompts', () => {
    const result = buildAskUserQuestionCancelledToolResult()
    assert.equal(result.isError, true)
    assert.equal(result.content[0].text, 'Question cancelled.')
  })
})
