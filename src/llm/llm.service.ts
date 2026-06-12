import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import { SearchResult } from '../search/search.service';

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly genai: GoogleGenAI;
  private readonly model: string;

  constructor(private readonly config: ConfigService) {
    this.genai = new GoogleGenAI({ apiKey: this.config.getOrThrow('GEMINI_API_KEY') });
    this.model = this.config.get('GEMINI_MODEL', 'gemini-2.5-flash');
  }

  async generateAnswer(question: string, sources: SearchResult[]): Promise<string> {
    const context = sources
      .slice(0, 8)
      .map((s, i) => `[Fuente ${i + 1}: ${s.doc_folder} – ${s.title}]\n${s.content}`)
      .join('\n\n');

    const prompt = `Eres el asistente del Knowledge Center de Pacífico Seguros. \
Responde de forma detallada y completa basándote ÚNICAMENTE en las fuentes proporcionadas. \
Cita las fuentes relevantes con [Fuente N]. No inventes información que no esté en las fuentes.

FUENTES:
${context}

PREGUNTA: ${question}

RESPUESTA DETALLADA:`;

    try {
      const res = await this.genai.models.generateContent({
        model: this.model,
        contents: prompt,
        config: {
          temperature: 0.2,
          maxOutputTokens: 2048,
          topP: 0.9,
          topK: 20,
        },
      });
      return res.text ?? '';
    } catch (err) {
      this.logger.error('LLM generation failed', err);
      return 'No se pudo generar una respuesta en este momento.';
    }
  }
}
