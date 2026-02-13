import type { NextApiRequest, NextApiResponse } from "next";
import { GoogleGenerativeAI } from "@google/generative-ai";

type Dificuldade = "fácil" | "médio" | "difícil";

type ReqBody = {
  tema?: unknown;
  quantidade?: unknown; // 10 | 20 | 30 (vamos clamp)
  dificuldade?: unknown;
  banca?: unknown;
};

const GABARITOS = ["A", "B", "C", "D"] as const;
type Gabarito = (typeof GABARITOS)[number];

type QuestaoIA = {
  enunciado: string;
  alternativaA: string;
  alternativaB: string;
  alternativaC: string;
  alternativaD: string;
  gabarito: Gabarito;
  explicacao?: string;
  dificuldade?: Dificuldade;
};

type RespostaIA = {
  titulo?: unknown;
  tema?: unknown;
  questoes: unknown;
};

type QuestaoAPI = QuestaoIA & { createdAt: string };

type ApiOk = { titulo: string; tema: string; questoes: QuestaoAPI[] };
type ApiErr = { error: string; detail?: string };

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("Resposta da IA não veio em JSON válido");
  }
}

function isRespostaIA(data: unknown): data is RespostaIA {
  return isObject(data) && "questoes" in data;
}

function isGabarito(v: string): v is Gabarito {
  return (GABARITOS as readonly string[]).includes(v);
}

function sanitizeGabarito(v: unknown): Gabarito {
  const s = String(v ?? "A").toUpperCase();
  return isGabarito(s) ? s : "A";
}

function sanitizeDificuldade(v: unknown): Dificuldade | undefined {
  const s = String(v ?? "").toLowerCase();
  if (s === "fácil") return "fácil";
  if (s === "médio" || s === "medio") return "médio";
  if (s === "difícil" || s === "dificil") return "difícil";
  return undefined;
}

function toQuestaoIAList(raw: unknown): { titulo?: string; tema?: string; questoes: QuestaoIA[] } {
  if (!isRespostaIA(raw)) return { questoes: [] };

  const list = raw.questoes;
  if (!Array.isArray(list)) return { questoes: [] };

  const titulo = raw.titulo != null ? String(raw.titulo) : undefined;
  const tema = raw.tema != null ? String(raw.tema) : undefined;

  const questoes = list.map((q): QuestaoIA => {
    const obj = isObject(q) ? q : {};
    return {
      enunciado: String(obj.enunciado ?? ""),
      alternativaA: String(obj.alternativaA ?? ""),
      alternativaB: String(obj.alternativaB ?? ""),
      alternativaC: String(obj.alternativaC ?? ""),
      alternativaD: String(obj.alternativaD ?? ""),
      gabarito: sanitizeGabarito(obj.gabarito),
      explicacao: obj.explicacao != null ? String(obj.explicacao) : undefined,
      dificuldade: sanitizeDificuldade(obj.dificuldade),
    };
  });

  return { titulo, tema, questoes };
}

async function generateWithFallback(genAI: GoogleGenerativeAI, prompt: string): Promise<string> {
  // ✅ Ordem: rápido/barato primeiro + fallbacks compatíveis
  const models = ["gemini-2.5-flash", "gemini-1.5-flash", "gemini-1.5-pro"] as const;

  let lastErr: unknown = null;

  for (const name of models) {
    try {
      const model = genAI.getGenerativeModel({ model: name });
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (e) {
      lastErr = e;
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? "erro");
  throw new Error(`Nenhum modelo disponível. Último erro: ${msg}`);
}


export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiOk | ApiErr>
) {
  // ✅ CORS
  const allowedOrigin = process.env.CORS_ORIGIN ?? "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    const body = (req.body ?? {}) as ReqBody;

    const tema = typeof body.tema === "string" ? body.tema.trim() : "";
    if (!tema) return res.status(400).json({ error: "tema inválido" });

    const quantidadeNum = Number(body.quantidade);
    const quantidade = clamp(Number.isFinite(quantidadeNum) ? quantidadeNum : 10, 10, 30);

    const diff = sanitizeDificuldade(body.dificuldade) ?? "médio";
    const banca = typeof body.banca === "string" ? body.banca.trim() : "mista";

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY não configurada" });

    const genAI = new GoogleGenerativeAI(apiKey);

    const prompt = `
Você é um elaborador de provas de CONCURSO PÚBLICO brasileiro.

TAREFA
Crie um SIMULADO (estilo prova real) com ${quantidade} questões sobre: "${tema}".
Dificuldade: ${diff}.
Banca/estilo: ${banca} (se "mista", misture estilos comuns de concursos).

FORMATO (OBRIGATÓRIO)
Retorne APENAS um JSON válido (sem markdown, sem texto antes/depois), com EXATAMENTE esta estrutura:

{
  "titulo": "Simulado - ${tema}",
  "tema": "${tema}",
  "questoes": [
    {
      "enunciado": "string",
      "alternativaA": "string",
      "alternativaB": "string",
      "alternativaC": "string",
      "alternativaD": "string",
      "gabarito": "A",
      "explicacao": "string",
      "dificuldade": "${diff}"
    }
  ]
}

REGRAS
- Questões objetivas e com linguagem formal.
- Alternativas plausíveis, diferentes e mutuamente exclusivas.
- Apenas UMA alternativa correta (A/B/C/D).
- Explicação em 2 a 5 linhas, direta.
- Não inventar número de artigo/lei específico se não tiver certeza.
- Aspas duplas no JSON, sem vírgulas finais, sem campos extras.
`.trim();

    const text = await generateWithFallback(genAI, prompt);

    const raw = extractJson(text);
    const parsed = toQuestaoIAList(raw);

    if (!parsed.questoes || parsed.questoes.length === 0) {
      return res.status(500).json({
        error: "Formato inválido retornado pela IA",
        detail: "A resposta não trouxe um array válido em 'questoes'.",
      });
    }

    const now = new Date().toISOString();
    const questoes: QuestaoAPI[] = parsed.questoes.slice(0, quantidade).map((q) => ({
      ...q,
      dificuldade: q.dificuldade ?? diff,
      createdAt: now,
    }));

    const titulo = (parsed.titulo && parsed.titulo.trim()) || `Simulado - ${tema}`;
    const temaOut = (parsed.tema && parsed.tema.trim()) || tema;

    return res.status(200).json({ titulo, tema: temaOut, questoes });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: "Erro ao gerar prova", detail: message });
  }
}
