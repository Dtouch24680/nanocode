export function isAskUserQuestionPayload(payload) {
  const questions = payload?.questions
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) return false
  return questions.every((question) => (
    question &&
    typeof question.question === 'string' &&
    Array.isArray(question.options) &&
    question.options.length >= 2 &&
    question.options.length <= 4
  ))
}

export function normalizeAskUserQuestionPayload(payload) {
  if (!isAskUserQuestionPayload(payload)) return []
  return payload.questions.map((question) => ({
    question: question.question,
    header: typeof question.header === 'string' ? question.header : '',
    multiSelect: question.multiSelect === true,
    options: question.options.map((option) => ({
      label: typeof option?.label === 'string' ? option.label : '',
      description: typeof option?.description === 'string' ? option.description : '',
      ...(typeof option?.preview === 'string' ? { preview: option.preview } : {}),
    })),
  }))
}

export function buildAskUserQuestionResult(payload, responses) {
  const questions = normalizeAskUserQuestionPayload(payload)
  if (questions.length === 0) {
    throw new Error('Invalid AskUserQuestion payload.')
  }
  if (!Array.isArray(responses) || responses.length !== questions.length) {
    throw new Error('Incomplete AskUserQuestion response.')
  }

  const answers = {}
  const freeform = []

  questions.forEach((question, index) => {
    const response = responses[index] || {}
    const selectedLabels = Array.isArray(response.selectedLabels)
      ? response.selectedLabels.filter((label) => typeof label === 'string' && label.trim())
      : []
    const otherText = typeof response.otherText === 'string' ? response.otherText.trim() : ''

    if (question.multiSelect) {
      const combined = [...selectedLabels]
      if (otherText) combined.push(otherText)
      if (combined.length === 0) {
        throw new Error(`Please answer "${question.header || question.question}".`)
      }
      answers[question.question] = combined.join(', ')
      if (otherText) freeform.push(otherText)
      return
    }

    if (selectedLabels.length > 1) {
      throw new Error(`"${question.header || question.question}" only allows one choice.`)
    }

    const answer = otherText || selectedLabels[0] || ''
    if (!answer) {
      throw new Error(`Please answer "${question.header || question.question}".`)
    }
    answers[question.question] = answer
    if (otherText) freeform.push(otherText)
  })

  const result = { questions, answers }
  if (freeform.length > 0) {
    result.response = freeform.join('\n')
  }
  return result
}

export function buildAskUserQuestionToolResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Invalid AskUserQuestion result.')
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
    structuredContent: result,
  }
}

export function buildAskUserQuestionCancelledToolResult(message = 'Question cancelled.') {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: message,
      },
    ],
  }
}
