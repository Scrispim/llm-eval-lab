# llm-eval-lab

Benchmark de LLMs (via OpenRouter) em **investigações de observabilidade**, medindo **acurácia** e **latência** no **Langfuse**.
Objetivo de estudo: decidir qual modelo/agente usar e aprender a instrumentar isso no serviço real.

## Como funciona

```
dataset (gabarito) ──► harness ──► agente (LLM via OpenRouter) ──MCP──► incident-sim (Grafana "falso")
                          │                    │                              └─ evidências GRAVADAS (fixtures)
                          │                    └─ cada chamada vira trace no Langfuse (latência, tokens)
                          └─ scorers ──► scores no Langfuse (acurácia + performance) ──► comparação por modelo
```

- **`src/mcp-incident-sim/`** – servidor MCP (stdio) com as mesmas ferramentas do `mcp-grafana`
  (`query_loki_logs`, `query_prometheus`, `tempo_get-trace`…), mas que responde com dados gravados de um incidente real.
  Todos os modelos veem **as mesmas evidências**: a única variável é o modelo.
- **`fixtures/<cenario>/tools.json`** – respostas gravadas. Cada entrada tem `tool`, `when` (regex contra os argumentos) e `result`.
- **`dataset/incidents.json`** – cenários + gabarito (causa raiz esperada, palavras-chave, causas proibidas, sinais esperados).
- **`src/scorers/`** – avaliadores: `completed`, `root_cause_keywords`, `no_forbidden_claims`, `signal_coverage`
  (por código, baratos e determinísticos) e `judge_root_cause` (LLM-as-judge, opcional).
- **`src/harness/agent.ts`** – loop do agente (LLM ⇄ ferramentas MCP) instrumentado com Langfuse.
- **`src/harness/run-eval.ts`** – roda `modelo × repetições` e imprime o resumo (acurácia, latência p50/p95).

## Instalação

### Pré-requisitos

- **Node.js >= 22.18** (`node -v`) e npm
- Conta no [OpenRouter](https://openrouter.ai/keys) → `OPENROUTER_API_KEY`
- Conta no [Langfuse Cloud](https://cloud.langfuse.com) (ou região US: `https://us.cloud.langfuse.com`) → projeto com
  `LANGFUSE_PUBLIC_KEY` e `LANGFUSE_SECRET_KEY`

Não há Docker, banco de dados nem serviço local: o Langfuse é cloud e o servidor MCP simulado é iniciado pelo próprio harness.

### Passos

```bash
# 1. Instale as dependências
npm install

# 2. Crie o arquivo de configuração
cp .env.example .env
```

3. Edite o `.env` e preencha:

| Variável | Obrigatória | Descrição |
|---|---|---|
| `OPENROUTER_API_KEY` | sim | Chave do OpenRouter |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | sim | Chaves do projeto no Langfuse |
| `LANGFUSE_BASE_URL` | não | Padrão `https://cloud.langfuse.com` (use a URL US se seu projeto for dessa região) |
| `MODELS` | não | Modelos a comparar, separados por vírgula (veja `npm run models`) |
| `JUDGE_MODEL` | não | Modelo juiz (LLM-as-judge); use um mais forte que os avaliados. Vazio = sem juiz |
| `REPEATS` | não | Execuções por modelo × cenário (padrão 3) |
| `MAX_STEPS` | não | Máx. de chamadas ao modelo por investigação (padrão 8) |
| `MAX_CONCURRENCY` | não | Concorrência; mantenha baixa em modelos `:free` (padrão 1) |

```bash
# 4. Confirme que está tudo certo (não precisa de chaves)
npm run typecheck
npm test
```

## Subir (up)

Não existe um daemon para "subir". Cada comando abre o que precisa e encerra sozinho. Ordem recomendada:

```bash
npm run models     # 1. lista modelos gratuitos com tool calling → copie os IDs para MODELS no .env
npm run seed       # 2. envia o dataset ao Langfuse (idempotente, pode repetir)
npm run eval       # 3. roda o benchmark (modelo × repetições) e imprime o resumo
```

Durante o `npm run eval`, o harness inicia o servidor MCP `incident-sim` como processo filho (stdio) para cada investigação.
Para depurar o servidor isoladamente:

```bash
npm run mcp:sim    # sobe o incident-sim em stdio (Ctrl+C para sair)
```

## Derrubar (down)

- **Fim normal:** ao terminar, `seed` e `eval` fecham o cliente MCP (encerrando o processo filho) e fazem *flush* dos traces
  para o Langfuse. Não há nada a desligar.
- **Interromper no meio:** `Ctrl+C` no terminal. Traces ainda não enviados podem não aparecer no Langfuse.
- **Processo preso (raro):** confirme e encerre o que sobrou:

  ```bash
  pgrep -fl "incident-sim|run-eval"
  pkill -f "mcp-incident-sim/server.ts"
  ```

- **Limpar resultados locais:** `rm -rf results` (a pasta já está no `.gitignore`).
- **Desinstalar:** `rm -rf node_modules` (e `.env`, se quiser remover as chaves da máquina).
  Os datasets e runs no Langfuse ficam na nuvem; apague-os pela interface do Langfuse se necessário.

## Comandos

| Comando | O que faz |
|---|---|
| `npm run models` | Lista modelos gratuitos com tool calling |
| `npm run seed` | Envia o dataset ao Langfuse |
| `npm run eval` | Roda o benchmark |
| `npm run mcp:sim` | Sobe o servidor MCP simulado (stdio) |
| `npm run typecheck` | Checagem de tipos (`tsc --noEmit`) |
| `npm test` | Testes (não precisam de chaves) |

## Custo e limites de cota

O gasto não é "uma chamada por execução". Cada investigação é um **loop**: o agente chama o modelo,
recebe uma ferramenta para usar, chama o modelo de novo com o resultado, e assim por diante. Somam-se
ainda as retentativas por 429/5xx, comuns em modelos `:free`.

```
requisicoes ≈ (passos + retentativas) × modelos × REPEATS
```

Medido neste projeto: uma investigação completa custa **15 a 16 requisições**.

| Configuração          | Investigações | Requisições |
| --------------------- | ------------- | ----------- |
| 1 modelo × `REPEATS=1` | 1             | ~16         |
| 2 modelos × `REPEATS=1`| 2             | ~32         |
| 1 modelo × `REPEATS=2` | 2             | ~32         |
| 2 modelos × `REPEATS=2`| 4             | ~64         |
| 2 modelos × `REPEATS=3`| 6             | ~96         |

A cota gratuita do OpenRouter é de cerca de **50 requisições por dia** (sobe para ~1000 depois de
adicionar créditos à conta). Ou seja: no plano gratuito cabem **2 ou 3 investigações por dia**.
Um `npm run eval` com 2 modelos × 3 repetições estoura a cota no meio e os últimos runs falham
com `429 free-models-per-day` — sem que isso diga nada sobre a qualidade dos modelos.

Por isso o `REPEATS` padrão é 2, e o mais econômico é rodar **um modelo por vez**:

```bash
MODELS=<um-modelo> REPEATS=1 npm run eval   # ~16 requisicoes, para validar o fluxo
REPEATS=1 npm run eval                      # ~32, compara os dois modelos
MODELS=<um-modelo> REPEATS=3 npm run eval   # ~48, mede a variancia de um modelo
```

Para distinguir "modelo ruim" de "cota estourada", filtre os traces por **Level = ERROR** e leia o
`statusMessage`: `429 free-models-per-day` é cota, `Upstream error` é fila do provedor, e
`sem resposta final dentro de MAX_STEPS` é o modelo se perdendo de fato.

## Roteiro de estudo

Na ordem, do mais barato ao mais caro. Os dois primeiros passos não gastam cota nenhuma.

**1. Entender as peças — `npm test`**

13 testes em menos de um segundo, sem precisar de chave. Os nomes descrevem o sistema inteiro:
o servidor MCP simulado, os scorers, o loop do agente e a árvore de traces. É o mapa mais rápido
do projeto.

**2. Ver o que o agente vai investigar**

```bash
node -e "const f=require('./fixtures/db-leaky-connections/tools.json'); console.log([...new Set(f.entries.map(e=>e.tool))].join('\n'))"
```

As ferramentas do "Grafana falso". O gabarito — a causa raiz que o agente precisa descobrir
sozinho — está em `dataset/incidents.json`.

**3. Uma investigação, e então ler o trace** (~16 requisições)

```bash
MODELS=<um-modelo> REPEATS=1 npm run eval
```

Este é o passo que mais ensina. Abra o trace em **Tracing → Traces** e acompanhe passo a passo:
cada `llm-call` mostra o raciocínio do modelo, cada ferramenta mostra a evidência que voltou.
É onde se vê *por que* ele acertou ou errou, não só o placar.

**4. Comparar dois modelos** (~32 requisições)

```bash
REPEATS=1 npm run eval
```

**5. Experimentar**

- **Estrangular o orçamento de passos:** `MAX_STEPS=4 MODELS=<um-modelo> REPEATS=1 npm run eval`.
  O agente fica sem fôlego no meio e falha com `sem resposta final dentro de MAX_STEPS`; no trace
  dá para ver exatamente onde parou.
- **Mexer no `SYSTEM_PROMPT`** em [`src/harness/agent.ts`](src/harness/agent.ts) e rodar de novo:
  é a forma mais direta de sentir o impacto do prompt na acurácia, com número no fim em vez de achismo.
- **Subir o `REPEATS`** para medir a variância: o mesmo modelo, com a mesma pergunta e as mesmas
  evidências, dá respostas diferentes. É por isso que uma execução só não prova nada.

## Resultados

**No terminal:** o `npm run eval` imprime a tabela por modelo (`ok`, `kw`, `judge`, `sinais`, latência p50/p95,
`retries`) e salva o JSON completo em `results/<timestamp>.json`.

**No Langfuse** (a URL é a do seu `LANGFUSE_BASE_URL`; use `us.cloud.langfuse.com` se seu projeto for da região US):

| Onde | O que você vê |
|---|---|
| **Tracing → Traces** | Cada investigação passo a passo: a árvore `investigate-incident` → `llm-call` / ferramentas, com latência e tokens por passo. Clique em um trace para abrir a linha do tempo. |
| **Datasets → incident-rca → Runs** | Compara os modelos lado a lado. Cada run é um `modelo \| timestamp \| rN`. |
| **Scores** | Filtra por `completed`, `root_cause_keywords`, `signal_coverage`, `judge_root_cause`. |

Para achar as falhas rápido, filtre os traces por **Level = ERROR**: o `statusMessage` traz o motivo
(modelo indisponível, provedor sobrecarregado, `sem resposta final dentro de MAX_STEPS`).

## Estrutura do trace no Langfuse

Cada item do experimento gera um trace com esta forma (seguindo as [best practices de tracing](https://langfuse.com/docs/observability/best-practices)):

```
experiment-item-run            (span, criado pelo runExperiment; ambiente sdk-experiment)
└─ investigate-incident        (agent; input = pergunta, output = resposta final)
   ├─ llm-call                 (generation: modelo, parâmetros, tokens, custo quando o OpenRouter informa)
   ├─ query_loki_logs          (tool: argumentos, saída, latência; level ERROR se a ferramenta falhou)
   ├─ llm-call
   └─ ...
```

- Nomes estáveis (`llm-call`, não `llm-call-3`): o passo fica em `metadata.step`.
- Tags e metadata em todas as observations: `scenario` e `model` — filtráveis na UI.
- O juiz (`JUDGE_MODEL`) roda depois do item, então aparece como trace próprio `judge-root-cause` com a tag `judge`.
- Teste local da árvore de spans (sem chaves): `src/harness/tracing.test.ts`.

Para o Claude Code manter esse padrão em mudanças futuras, instale a skill oficial da Langfuse
(MIT, não versionada aqui — está no `.gitignore`):

```bash
npx skills add langfuse/skills --skill langfuse
```

## Decisões de design

- **Fixtures em vez de Grafana ao vivo** – dados idênticos entre modelos e execuções (comparação justa e repetível).
- **Repetições (`REPEATS`)** – LLM não é determinística; uma execução não prova nada.
- **Latência só de execuções concluídas** e `retries` separado – em modelos `:free`, 429/fila do provedor não é lentidão do modelo.
- **Juiz mais forte que os avaliados** (`JUDGE_MODEL`). Se o juiz falha, o score é descartado (não pune o modelo).
- **Scores por código + juiz** – o código pega o que é objetivo; o juiz cobre respostas corretas com outras palavras.

## Limitações conhecidas / próximos passos

- Só 1 cenário (`db-leaky-connections`). Acurácia com um caso não diz muito: adicionar cenários (query lenta, memory leak,
  dependência fora do ar) em `fixtures/` + `dataset/`.
- Latência é o tempo total da chamada (sem streaming); **time-to-first-token** exige streaming.
- A fixture `count_over_time` (erros por minuto) foi montada a partir do que foi observado (~30/min), não capturada bruta.
- Modelos gratuitos: a lista muda, o rate limit varia e os provedores podem usar os prompts para treino. Use só dados de teste.
- Levar ao serviço real: trocar o `incident-sim` pelo `mcp-grafana` (mesmos nomes de ferramentas) no `agent.ts`.
