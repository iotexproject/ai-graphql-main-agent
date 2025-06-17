/**
 * AI Thinking Process Simulator
 * Implements character-by-character thinking output to create a more natural AI thinking experience
 */
export class ThinkingSimulator {
  private controller: ReadableStreamDefaultController;
  private encoder: TextEncoder;
  private streamId: string;
  private currentThinking: string = "";
  private currentIndex: number = 0;
  private isTyping: boolean = false;
  private typingTimeout: any = null;

  constructor(controller: ReadableStreamDefaultController, streamId: string) {
    this.controller = controller;
    this.encoder = new TextEncoder();
    this.streamId = streamId;
  }

  /**
   * Start a new thinking phase
   */
  async startThinking(content: string): Promise<void> {
    // If currently typing, complete the current content first
    if (this.isTyping) {
      await this.completeCurrentThinking();
    }

    this.currentThinking = content;
    this.currentIndex = 0;
    this.isTyping = true;

    // Start thinking tag
    this.controller.enqueue(
      this.encoder.encode(this.formatStreamingData("<thinking>", this.streamId))
    );

    // Start character-by-character output
    return new Promise((resolve) => {
      const typeNextChar = () => {
        if (this.currentIndex < this.currentThinking.length) {
          const char = this.currentThinking[this.currentIndex];
          this.controller.enqueue(
            this.encoder.encode(this.formatStreamingData(char, this.streamId))
          );
          this.currentIndex++;
          
          // Random delay to simulate irregular thinking speed
          const delay = 30 + Math.random() * 30; // 60-120ms
          this.typingTimeout = setTimeout(typeNextChar, delay);
        } else {
          // Output complete
          this.controller.enqueue(
            this.encoder.encode(this.formatStreamingData("</thinking>\n", this.streamId))
          );
          this.isTyping = false;
          this.typingTimeout = null;
          resolve();
        }
      };
      
      typeNextChar();
    });
  }

  /**
   * Quickly complete the current thinking output
   */
  private async completeCurrentThinking(): Promise<void> {
    if (!this.isTyping || this.typingTimeout === null) return;

    // Stop current character-by-character output
    if (this.typingTimeout) {
      clearTimeout(this.typingTimeout);
      this.typingTimeout = null;
    }

    // Quickly complete remaining content
    if (this.currentIndex < this.currentThinking.length) {
      const remainingContent = this.currentThinking.slice(this.currentIndex);
      this.controller.enqueue(
        this.encoder.encode(this.formatStreamingData(remainingContent, this.streamId))
      );
    }

    // End thinking tag
    this.controller.enqueue(
      this.encoder.encode(this.formatStreamingData("</thinking>\n", this.streamId))
    );

    this.isTyping = false;
  }

  /**
   * Force complete the current thinking (public method for external use)
   */
  forceComplete(): void {
    if (this.isTyping) {
      this.completeCurrentThinking();
    }
  }

  /**
   * Format SSE streaming data in OpenAI format
   */
  private formatStreamingData(
    content: string,
    id: string,
    finishReason: string | null = null
  ): string {
    const data = {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "openai/gpt-4o",
      choices: [
        {
          index: 0,
          delta: content ? { content } : {},
          finish_reason: finishReason,
        },
      ],
    };
    return `data: ${JSON.stringify(data)}\n\n`;
  }

  /**
   * Get random thinking content
   */
  static getRandomThinkingContent(stage: 'loading' | 'processing' | 'answering'): string {
    const contents = {
      loading: [
        "Analyzing project configuration and available API interfaces...",
        "Checking current project's API resources and system configuration...",
        "Loading project API documentation and interface information...",
        "Preparing system prompts and tool configuration...",
        "Initializing API call environment and necessary headers...",
        "Parsing project structure and related dependency configuration...",
        "Verifying API interface availability and permission settings..."
      ],
      processing: [
        "Analyzing user question intent and required data types...",
        "Evaluating which API interfaces are most suitable for this problem...",
        "Developing API call strategy and data processing plan...",
        "Preparing to build appropriate HTTP request parameters...",
        "Checking required and optional parameters in API documentation...",
        "Planning execution order and dependencies for multiple API calls...",
        "Optimizing request parameters for optimal data response..."
      ],
      answering: [
        "Starting API calls and data retrieval tasks...",
        "Processing API response data and preparing user-friendly answers...",
        "Organizing and formatting retrieved information...",
        "Preparing to provide detailed and accurate responses...",
        "Verifying data integrity and optimizing answer structure...",
        "Building clear and understandable answer format and content organization...",
        "Final verification of answer accuracy and completeness..."
      ]
    };

    const stageContents = contents[stage];
    return stageContents[Math.floor(Math.random() * stageContents.length)];
  }
} 