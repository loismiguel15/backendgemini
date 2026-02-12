// app/api/gerar-prova/route.ts
import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

type Body = {
  tema: string;
  quantidade: number; // 10 | 20 | 30
  banca?: string; // "FGV" | "CESPE" | "FCC" | ...
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

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;

    const tema = (body.tema || "").trim();
    const quantidade = clamp(Number(body.quantidade || 10), 10, 30);
    const banca = (body.banca || "mista").trim();
    const nivel = (body.nivel || "médio").trim();

    if (!tema) {
      return NextResponse.json({ error: "Tema é obrigatório." }, { status: 400 });
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

    const text = await gerarComGemini(prompt);

    const json = safeJsonParse<ProvaGerada>(text);

    if (!json || !Array.isArray(json.questoes)) {
      return NextResponse.json(
        { error: "Resposta inválida do modelo", raw: text.slice(0, 800) },
        { status: 500 }
      );
    }

    // garante tamanho certo
    json.questoes = json.questoes.slice(0, quantidade);

    return NextResponse.json(json);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Erro interno";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Gemini caller */
async function gerarComGemini(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY não configurada no .env.local");
  }

  const genAI = new GoogleGenerativeAI(apiKey);

  // Você pode trocar o modelo depois (flash é rápido/barato)
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const result = await model.generateContent(prompt);
  const text = result.response.text();

  return text;
}

/** Parse seguro */
function safeJsonParse<T>(text: string): T | null {
  // tenta direto
  try {
    return JSON.parse(text) as T;
  } catch {
    // tenta extrair o primeiro bloco JSON
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
