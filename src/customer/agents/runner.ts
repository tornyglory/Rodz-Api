import type { GenerativeModel, Content } from '@google/generative-ai'
import type { AgentResult } from './types'

export async function runAgentLoop(
  model: GenerativeModel,
  contents: Content[],
  executeTool: (name: string, args: any) => Promise<object>,
  maxLoops = 6,
): Promise<AgentResult> {
  let fullResponse = ''
  let loopCount    = 0
  const functionCalls: { name: string; args: any; result: object }[] = []

  while (loopCount < maxLoops) {
    loopCount++
    const genResult = await model.generateContent({ contents })
    const candidate = genResult.response.candidates?.[0]
    if (!candidate) break

    let functionCallPart: any = null
    let chunkText = ''

    for (const part of candidate.content?.parts ?? []) {
      if (part.text)              { chunkText += part.text; fullResponse += part.text }
      else if (part.functionCall) { functionCallPart = part.functionCall }
    }

    if (!functionCallPart) break

    const { name, args } = functionCallPart
    const fnResult = await executeTool(name, args)
    functionCalls.push({ name, args, result: fnResult })

    contents.push(
      chunkText
        ? { role: 'model', parts: [{ text: chunkText }, { functionCall: functionCallPart }] }
        : { role: 'model', parts: [{ functionCall: functionCallPart }] },
    )
    contents.push({ role: 'user', parts: [{ functionResponse: { name, response: fnResult } }] })
  }

  return { content: fullResponse, functionCalls }
}
