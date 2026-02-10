import type { NextApiRequest, NextApiResponse } from "next";
import { GoogleGenerativeAI } from "@google/generative-ai";

type Dificuldade = "fácil" | "médio" | "difícil";

type ReqBody = {
  assuntoNome?: unknown;
  quantidade?: unknown;
  dificuldade?: unknown;
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
  questoes: unknown;
};

type QuestaoAPI = QuestaoIA & { createdAt: string };

type ApiOk = { questoes: QuestaoAPI[] };
type ApiErr = { error: string; detail?: string };

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
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

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
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
  if (s === "difícil") return "difícil";

  return undefined;
}

function toQuestaoIAList(raw: unknown): QuestaoIA[] {
  if (!isRespostaIA(raw)) return [];

  const list = raw.questoes;
  if (!Array.isArray(list)) return [];

  return list.map((q): QuestaoIA => {
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
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiOk | ApiErr>
) {
  // ✅ CORS (resolve no Expo Web / Chrome)
  const allowedOrigin = process.env.CORS_ORIGIN ?? "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // ✅ Preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    const body = (req.body ?? {}) as ReqBody;

    const assuntoNome =
      typeof body.assuntoNome === "string" ? body.assuntoNome.trim() : "";

    if (!assuntoNome) {
      return res.status(400).json({ error: "assuntoNome inválido" });
    }

    const quantidadeNum = Number(body.quantidade);
    const qtd = clamp(Number.isFinite(quantidadeNum) ? quantidadeNum : 5, 1, 20);

    const diff = sanitizeDificuldade(body.dificuldade) ?? "médio";

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "GEMINI_API_KEY não configurada" });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const prompt = `
Você é um gerador de questões de concurso público.

TAREFA
Gere ${qtd} questões de múltipla escolha sobre: "${assuntoNome}".
Nível de dificuldade: ${diff}.

FORMATO (OBRIGATÓRIO)
Retorne APENAS um JSON válido (sem markdown, sem texto antes/depois, sem blocos de código).
O JSON deve ter EXATAMENTE esta estrutura:

{
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
- "gabarito" deve ser: "A" ou "B" ou "C" ou "D".
- Alternativas diferentes entre si.
- Explicação em 1 a 3 frases.
- Aspas duplas no JSON.
- Sem vírgulas finais.
- Sem campos extras.
`.trim();

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const raw = extractJson(text);
    const base = toQuestaoIAList(raw);

    if (base.length === 0) {
      return res.status(500).json({
        error: "Formato inválido retornado pela IA",
        detail: "A resposta não trouxe um array válido em 'questoes'.",
      });
    }

    const now = new Date().toISOString();

    const questoes: QuestaoAPI[] = base.map((q) => ({
      ...q,
      dificuldade: q.dificuldade ?? diff,
      createdAt: now,
    }));

    return res.status(200).json({ questoes });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: "Erro ao gerar questões", detail: message });
  }
}
