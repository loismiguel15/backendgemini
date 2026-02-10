import type { NextApiRequest, NextApiResponse } from "next";
import { GoogleGenerativeAI } from "@google/generative-ai";

type ReqBody = {
  assuntoNome: string;
  quantidade: number;
  dificuldade?: "fácil" | "médio" | "difícil";
};

type QuestaoIA = {
  enunciado: string;
  alternativaA: string;
  alternativaB: string;
  alternativaC: string;
  alternativaD: string;
  gabarito: "A" | "B" | "C" | "D";
  explicacao?: string;
  dificuldade?: "fácil" | "médio" | "difícil";
};

type RespostaIA = {
  questoes: QuestaoIA[];
};

type QuestaoAPI = QuestaoIA & { createdAt: string };

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function extractJson(text: string): unknown {
  // tenta parse direto
  try {
    return JSON.parse(text);
  } catch {
    // fallback: pega o maior bloco { ... }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("Resposta da IA não veio em JSON válido");
  }
}

function isRespostaIA(data: unknown): data is RespostaIA {
  if (typeof data !== "object" || data === null) return false;
  if (!("questoes" in data)) return false;

  const questoes = (data as { questoes?: unknown }).questoes;
  return Array.isArray(questoes);
}

function toQuestaoIAList(data: RespostaIA): QuestaoIA[] {
  // sanitiza e garante valores mínimos
  return data.questoes.map((q) => ({
    enunciado: String((q as unknown as { enunciado?: unknown }).enunciado ?? ""),
    alternativaA: String((q as unknown as { alternativaA?: unknown }).alternativaA ?? ""),
    alternativaB: String((q as unknown as { alternativaB?: unknown }).alternativaB ?? ""),
    alternativaC: String((q as unknown as { alternativaC?: unknown }).alternativaC ?? ""),
    alternativaD: String((q as unknown as { alternativaD?: unknown }).alternativaD ?? ""),
    gabarito: (["A", "B", "C", "D"].includes(
      String((q as unknown as { gabarito?: unknown }).gabarito ?? "A")
    )
      ? String((q as unknown as { gabarito?: unknown }).gabarito ?? "A")
      : "A") as "A" | "B" | "C" | "D",
    explicacao:
      (q as unknown as { explicacao?: unknown }).explicacao != null
        ? String((q as unknown as { explicacao?: unknown }).explicacao)
        : undefined,
    dificuldade:
      (q as unknown as { dificuldade?: unknown }).dificuldade != null
        ? (String((q as unknown as { dificuldade?: unknown }).dificuldade) as
            | "fácil"
            | "médio"
            | "difícil")
        : undefined,
  }));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Método não permitido" });
    }

    const { assuntoNome, quantidade, dificuldade } = req.body as ReqBody;

    if (!assuntoNome || typeof assuntoNome !== "string") {
      return res.status(400).json({ error: "assuntoNome inválido" });
    }

    const qtd = clamp(Number.isFinite(Number(quantidade)) ? Number(quantidade) : 5, 1, 20);
    const diff: "fácil" | "médio" | "difícil" = dificuldade ?? "médio";

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
- O campo "gabarito" deve ser APENAS: "A" ou "B" ou "C" ou "D".
- As alternativas devem ser diferentes entre si (não repetir).
- A explicação deve justificar o gabarito em 1 a 3 frases.
- Não use aspas simples. Use aspas duplas no JSON.
- Não inclua vírgulas finais no JSON.
- Não inclua comentários no JSON.
- Não inclua campos extras.
`;


    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const raw = extractJson(text);

    if (!isRespostaIA(raw)) {
      return res.status(500).json({
        error: "Formato inválido retornado pela IA",
        detail: "Esperado objeto com propriedade 'questoes' (array).",
      });
    }

    const now = new Date().toISOString();

    const questoesBase = toQuestaoIAList(raw);
    const questoes: QuestaoAPI[] = questoesBase.map((q) => ({
      ...q,
      dificuldade: q.dificuldade ?? diff,
      createdAt: now,
    }));

    return res.status(200).json({ questoes });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return res.status(500).json({
      error: "Erro ao gerar questões",
      detail: message,
    });
  }
}
