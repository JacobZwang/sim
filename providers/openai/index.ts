import OpenAI from 'openai'
import { executeTool } from '@/tools'
import { ProviderConfig, ProviderRequest, ProviderResponse } from '../types'

export const openaiProvider: ProviderConfig = {
  id: 'openai',
  name: 'OpenAI',
  description: "OpenAI's GPT models",
  version: '1.0.0',
  models: ['gpt-4o', 'o1', 'o3-mini'],
  defaultModel: 'gpt-4o',

  executeRequest: async (request: ProviderRequest): Promise<ProviderResponse> => {
    // Add tool execution mode with default of 'parameters-only'
    const toolExecutionMode = 'parameters-only' // 'sync', 'parameters-only'

    if (!request.apiKey) {
      throw new Error('API key is required for OpenAI')
    }

    const openai = new OpenAI({
      apiKey: request.apiKey,
      dangerouslyAllowBrowser: true,
    })

    // Start with an empty array for all messages
    const allMessages = []

    // Add system prompt if present
    if (request.systemPrompt) {
      allMessages.push({
        role: 'system',
        content: request.systemPrompt,
      })
    }

    // Add context if present
    if (request.context) {
      allMessages.push({
        role: 'user',
        content: request.context,
      })
    }

    // Add remaining messages
    if (request.messages) {
      allMessages.push(...request.messages)
    }

    // Transform tools to OpenAI format if provided
    const tools = request.tools?.length
      ? request.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.id,
            description: tool.description,
            parameters: tool.parameters,
          },
        }))
      : undefined

    // Build the request payload
    const payload: any = {
      model: request.model || 'gpt-4o',
      messages: allMessages,
    }

    // Add optional parameters
    if (request.temperature !== undefined) payload.temperature = request.temperature
    if (request.maxTokens !== undefined) payload.max_tokens = request.maxTokens

    // Add response format for structured output if specified
    if (request.responseFormat) {
      payload.response_format = { type: 'json_object' }
    }

    // Add tools if provided
    if (tools?.length) {
      payload.tools = tools
      payload.tool_choice = 'auto'
    }

    // Make the initial API request
    const startTime = Date.now()
    console.log(`[OpenAI Provider] Starting request at ${new Date(startTime).toISOString()}`)

    const firstRequestStartTime = Date.now()
    let currentResponse = await openai.chat.completions.create(payload)
    const firstRequestEndTime = Date.now()
    console.log(
      `[OpenAI Provider] First request took ${firstRequestEndTime - firstRequestStartTime}ms`
    )

    // Extract content and token information
    let content = currentResponse.choices[0]?.message?.content || ''
    let tokens = {
      prompt: currentResponse.usage?.prompt_tokens || 0,
      completion: currentResponse.usage?.completion_tokens || 0,
      total: currentResponse.usage?.total_tokens || 0,
    }

    // Extract tool calls if present
    let toolCallsInResponse = currentResponse.choices[0]?.message?.tool_calls
    const toolCalls =
      toolCallsInResponse?.map((toolCall) => ({
        name: toolCall.function.name,
        arguments: JSON.parse(toolCall.function.arguments),
      })) || []

    // If parameters-only mode or no tool calls, return immediately
    if (toolExecutionMode === 'parameters-only' || !toolCalls.length) {
      const endTime = Date.now()
      console.log(
        `[OpenAI Provider] Completed request at ${new Date(endTime).toISOString()} (${endTime - startTime}ms)`
      )

      return {
        content,
        model: request.model,
        tokens,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        // No tool results since we didn't execute them
      }
    }

    // If we reach here, we're in sync mode and need to execute tools
    let toolResults = []
    let currentMessages = [...allMessages]
    let iterationCount = 0
    const MAX_ITERATIONS = 10 // Prevent infinite loops

    try {
      while (iterationCount < MAX_ITERATIONS) {
        // Check for tool calls
        if (!toolCallsInResponse || toolCallsInResponse.length === 0) {
          break
        }

        // Process each tool call
        for (const toolCall of toolCallsInResponse) {
          try {
            const toolName = toolCall.function.name
            const toolArgs = JSON.parse(toolCall.function.arguments)

            // Get the tool from the tools registry
            const tool = request.tools?.find((t) => t.id === toolName)
            if (!tool) continue

            // Execute the tool
            const mergedArgs = { ...tool.params, ...toolArgs }
            const result = await executeTool(toolName, mergedArgs, true)

            if (!result.success) continue

            toolResults.push(result.output)

            // Add the tool call and result to messages
            currentMessages.push({
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: toolCall.id,
                  type: 'function',
                  function: {
                    name: toolName,
                    arguments: toolCall.function.arguments,
                  },
                },
              ],
            })

            currentMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(result.output),
            })
          } catch (error) {
            console.error('Error processing tool call:', error)
          }
        }

        // Make the next request with updated messages
        const nextPayload = {
          ...payload,
          messages: currentMessages,
        }

        // Make the next request
        currentResponse = await openai.chat.completions.create(nextPayload)

        // Update content if we have a text response
        if (currentResponse.choices[0]?.message?.content) {
          content = currentResponse.choices[0].message.content
        }

        // Get new tool calls for next iteration
        toolCallsInResponse = currentResponse.choices[0]?.message?.tool_calls

        // Update token counts
        if (currentResponse.usage) {
          tokens.prompt += currentResponse.usage.prompt_tokens || 0
          tokens.completion += currentResponse.usage.completion_tokens || 0
          tokens.total += currentResponse.usage.total_tokens || 0
        }

        iterationCount++
      }
    } catch (error) {
      console.error('Error in OpenAI request:', error)
      throw error
    }

    const endTime = Date.now()
    console.log(
      `[OpenAI Provider] Completed request at ${new Date(endTime).toISOString()} (${endTime - startTime}ms)`
    )
    console.log(`[OpenAI Provider] Time taken: ${endTime - startTime}ms`)

    return {
      content,
      model: request.model,
      tokens,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      toolResults: toolResults.length > 0 ? toolResults : undefined,
    }
  },
}
