# InstaBot — Automação de Comentários do Instagram

Ferramenta pessoal para automação de respostas a comentários no Instagram, similar ao ManyChat. Quando alguém comenta com uma palavra-chave específica em seus posts, o bot responde automaticamente no comentário e/ou envia uma DM.

---

## Funcionalidades

- ✅ Autenticação OAuth 2.0 com Instagram Graph API (múltiplas contas)
- ✅ Regras por múltiplas palavras-chave → resposta no comentário + DM
- ✅ **Flow Builder visual** (estilo ManyChat): arraste blocos (gatilho → mensagem → espera → condição) conectados no canvas, com delays e ramificação SIM/NÃO
- ✅ **Mensagens ricas**: texto, imagem, botões e cards, com prévia ao vivo
- ✅ **Inbox ao vivo**: veja conversas e responda manualmente (texto, imagem e botões)
- ✅ **Audiência**: contatos automáticos com tags, segmentação e **broadcast** (respeitando a janela de 24h)
- ✅ **Gatilhos**: comentário, **DM por palavra-chave** e **resposta de story**
- ✅ **Follow-gate** com botão "Já te segui! ✅" (só envia o link após seguir)
- ✅ Variáveis dinâmicas `{{username}}` e `{{keyword}}`
- ✅ Cooldown por usuário, filtro por post, prioridade (arrastar para reordenar)
- ✅ Fila de reenvio automático em caso de erro de API
- ✅ Alerta de token expirando + exportação de logs em CSV
- ✅ Webhook em tempo real • Logs completos • Simulador de testes
- ✅ Interface dark/light mode

---

## Pré-requisitos

- Node.js **22.5+** (usa o módulo SQLite nativo `node:sqlite` — sem dependências de compilação)
- Conta no [Meta for Developers](https://developers.facebook.com/)
- Instagram Business ou Creator Account
- Instagram conectado a uma Página do Facebook
- [ngrok](https://ngrok.com/) para expor o servidor local (nos testes)

---

## Passo 1 — Criar o App no Meta for Developers

1. Acesse [developers.facebook.com](https://developers.facebook.com/) e clique em **"Meus Apps"** → **"Criar App"**
2. Selecione **"Empresa"** como tipo de app e clique em Avançar
3. Dê um nome ao app (ex: `InstaBot Pessoal`) e clique em **Criar app**
4. No painel do app, clique em **"Adicionar produto"**
5. Encontre **"Instagram Graph API"** e clique em **Configurar**

### Configurar OAuth

1. No menu lateral, vá em **Instagram > Configurações básicas**
2. Anote o **ID do app** e o **Segredo do app** (você vai precisar)
3. Em **"URIs de redirecionamento OAuth válidos"**, adicione:
   ```
   https://SEU-NGROK-URL.ngrok-free.app/auth/callback
   ```
4. Em **"Origens do JavaScript permitidas"**, adicione o mesmo URL ngrok

### Adicionar permissões

1. Vá em **Instagram > Permissões e recursos**
2. Adicione e solicite as seguintes permissões:
   - `instagram_basic`
   - `instagram_manage_comments`
   - `instagram_manage_messages`
   - `pages_show_list`
   - `pages_read_engagement`

> **Nota:** Para uso pessoal em modo de desenvolvimento, você pode usar o app sem publicá-lo. Adicione seu Instagram como **Testador** em **Funções > Testadores**.

---

## Passo 2 — Configurar Variáveis de Ambiente

Copie o arquivo de exemplo:

```bash
cp .env.example .env
```

Preencha o `.env`:

```env
INSTAGRAM_APP_ID=123456789012345        # ID do app no Meta
INSTAGRAM_APP_SECRET=abc123...          # Segredo do app
INSTAGRAM_WEBHOOK_VERIFY_TOKEN=meu_token_secreto_aleatorio
SESSION_SECRET=outra_string_aleatoria
BASE_URL=https://xxxx.ngrok-free.app    # URL pública do ngrok
PORT=3000
APP_PASSWORD=                           # senha do painel — OBRIGATÓRIA ao hospedar online
```

> **Segurança:** com `APP_PASSWORD` vazio o painel abre sem senha (ok só para teste local). Ao hospedar, defina uma senha — ela protege todo o painel (regras, inbox, envio de DMs). O webhook é protegido separadamente pela assinatura da Meta (`INSTAGRAM_APP_SECRET`).

---

## Passo 3 — Instalar dependências e rodar

```bash
cd instagram-automation
npm install
npm start
```

> **Nota:** O banco de dados usa o módulo `node:sqlite` embutido no Node.js 22.5+. Não é necessário instalar nenhuma dependência nativa — o `npm install` é rápido e sem compilação.

O servidor estará rodando em `http://localhost:3000`

---

## Passo 4 — Expor com ngrok

Em outro terminal:

```bash
ngrok http 3000
```

Copie a URL gerada (ex: `https://abc123.ngrok-free.app`) e:
1. Atualize `BASE_URL` no `.env`
2. Atualize a URI de redirecionamento no painel Meta
3. Reinicie o servidor: `npm start`

---

## Passo 5 — Configurar o Webhook no Meta

1. No painel do app, vá em **Instagram > Webhooks**
2. Clique em **"Adicionar assinatura"** no objeto `instagram`
3. Preencha:
   - **URL do callback:** `https://SEU-NGROK-URL.ngrok-free.app/webhook`
   - **Token de verificação:** o mesmo valor de `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` do seu `.env`
4. Clique em **"Verificar e salvar"**
5. Após verificar, **inscreva-se nos campos**:
   - `comments` — para receber e responder comentários
   - `messages` — para o **follow-gate**, a **Inbox ao vivo** e o recebimento de DMs

---

## Passo 6 — Conectar o Instagram

1. Abra `http://localhost:3000` no navegador
2. Clique em **"Conectar Instagram"**
3. Autorize as permissões solicitadas
4. Você será redirecionado de volta ao painel com a conta conectada

---

## Usando a ferramenta

### Criar uma regra

1. Vá na aba **Regras** → **Nova Regra**
2. Defina:
   - **Palavra-chave:** ex: `link` (sem distinção de maiúsculas/minúsculas)
   - **Resposta no comentário:** ex: `Oi! Te mandei o link por DM 😊`
   - **Mensagem DM:** ex: `Aqui está o link: https://...`
   - **Exigir que me siga:** ative se quiser enviar a DM apenas para seguidores
3. Salve a regra

### Testar

Na aba **Configurações**, use o simulador de comentários para testar suas regras sem precisar postar no Instagram.

### Ver logs

Na aba **Logs**, você visualiza todas as ações: comentários recebidos, respostas enviadas, DMs enviadas e possíveis erros.

---

## Sobre a funcionalidade "Exigir seguir"

Quando ativada, o bot verifica se o usuário que comentou segue sua conta antes de enviar a DM. Isso usa o endpoint de followers da API do Instagram. Se a verificação não for possível (limitação de API), o bot assume que o usuário segue para evitar problemas de UX.

> **Limitação:** A API do Instagram só permite verificar followers de contas Business/Creator com permissão `instagram_manage_messages`. Em modo de desenvolvimento, essa verificação pode falhar silenciosamente.

---

## Estrutura do projeto

```
instagram-automation/
├── server.js          # Entry point Express
├── database.js        # SQLite setup e migrations
├── routes/
│   ├── auth.js        # OAuth flow
│   ├── rules.js       # CRUD de regras
│   ├── webhook.js     # Recebe e processa comentários
│   └── logs.js        # Listagem de logs
├── public/
│   ├── index.html     # SPA frontend
│   ├── style.css      # Dark theme UI
│   └── app.js         # Lógica do frontend
├── .env.example
└── package.json
```

---

## Solução de problemas

| Problema | Solução |
|---|---|
| "No Instagram Business Account found" | Certifique-se de que seu Instagram está conectado a uma Página do Facebook |
| Webhook não verifica | Confirme que `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` no `.env` é igual ao inserido no painel Meta |
| DM não é enviada | Verifique se a permissão `instagram_manage_messages` foi aprovada |
| Token expirado | Reconecte a conta (tokens duram ~60 dias) |
| ngrok URL mudou | Atualize `BASE_URL` no `.env`, a URI no Meta e reinicie |

---

## Desenvolvimento

```bash
npm run dev   # Usa nodemon para auto-reload
```

O banco de dados SQLite é criado automaticamente em `data.db` na raiz do projeto.
