import type { NextApiRequest, NextApiResponse } from "next";
import { GoogleGenerativeAI } from "@google/generative-ai";

type Body = {
  tema: string;
  quantidade: number;
  banca?: string;
  nivel?: "fácil" | "médio" | "difícil" | string;
};

type QuestaoGerada = {
  enunciado: string;
  alternativaA: string;
  alternativaB: string;
  alternativaC: string;
  alternativaD: string;
  gabarito: "A" | "B" | "C" | "D";
  explicacao?: string;
};

type ProvaGerada = {
  titulo: string;
  tema: string;
  questoes: QuestaoGerada[];
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST"]);
      return res.status(405).json({ error: "Método não permitido" });
    }

    const body = req.body as Body;

    const tema = (body?.tema ?? "").trim();
    const quantidade = clamp(Number(body?.quantidade ?? 10), 10, 30);
    const banca = (body?.banca ?? "mista").trim();
    const nivel = (body?.nivel ?? "médio").trim();

    if (!tema) {
      return res.status(400).json({ error: "Tema é obrigatório." });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "GEMINI_API_KEY não configurada na Vercel." });
    }

    const prompt = `
Você é um elaborador de provas de CONCURSO PÚBLICO brasileiro.
Crie um SIMULADO (estilo prova real) sobre o tema: "${tema}".

Parâmetros:
- Quantidade: ${quantidade}
- Banca/estilo: ${banca} (se "mista", misture estilos comuns)
- Nível: ${nivel}

Regras de qualidade (obrigatório):
- Questões objetivas, linguagem formal, pegadinhas moderadas.
- Alternativas plausíveis e mutuamente exclusivas.
- Evite questões genéricas; foque em pontos cobrados em concursos.
- Uma única alternativa correta (A, B, C ou D).
- Explique o gabarito em 2–5 linhas, de forma técnica e direta.
- NÃO cite “segundo o Gemini”.
- NÃO invente artigo/lei com número específico se não tiver certeza.

Retorne APENAS JSON VÁLIDO (sem markdown) no formato:
{
  "titulo": "Simulado - <tema>",
  "tema": "<tema>",
  "questoes": [
    {
      "enunciado": "...",
      "alternativaA": "...",
      "alternativaB": "...",
      "alternativaC": "...",
      "alternativaD": "...",
      "gabarito": "A",
      "explicacao": "..."
    }
  ]
}
`.trim();

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const parsed = safeJsonParse<ProvaGerada>(text);

    if (!parsed || !Array.isArray(parsed.questoes)) {
      return res.status(500).json({
        error: "Resposta inválida do modelo",
        raw: text.slice(0, 800),
      });
    }

    const out: ProvaGerada = {
      titulo: parsed.titulo ?? `Simulado - ${tema}`,
      tema: parsed.tema ?? tema,
      questoes: parsed.questoes.slice(0, quantidade),
    };

    return res.status(200).json(out);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Erro interno";
    return res.status(500).json({ error: message });
  }
}

/** Parse seguro */
function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");

    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }

    return null;
  }
}



function clamp(n: number, min: number, max: number) {
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(n, max));
}
