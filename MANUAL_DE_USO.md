# 🎯 Tactical Command — Manual de Uso & Guia de Campo
**Controlador Tático de Partidas de Paintball e Airsoft (PWA Offline + Sessões em Nuvem)**

---

## 1. Visão Geral do Sistema
O **Tactical Command** foi projetado com interface de altíssimo contraste (**Dark Mode Tático**) para leitura rápida sob sol forte e botões grandes compatíveis com luvas táticas. Ele pode operar em dois modos:

1. **Modo Local / Offline (1 Aparelho):**
   * Ideal para campos sem sinal de internet. O árbitro controla o cronômetro, o alistamento e as baixas diretamente em um celular ou tablet na mesa de comando.
   * Todos os dados ficam salvos automaticamente no aparelho (`localStorage`) e funcionam 100% em modo avião após o primeiro acesso.
2. **Modo Sessão Online em Tempo Real (Vários Celulares):**
   * O Juiz cria uma sala clicando em **`☁️ SESSÃO ONLINE`** e compartilha o código (ex: `ALPHA-42` ou código personalizado como `DOMINGO`) ou envia o **Link de Convite** no grupo do WhatsApp.
   * Cada jogador entra pelo próprio celular, digita seu **Codinome de Operador**, escolhe seu esquadrão (**Time A** ou **Time B**) e passa a ver o cronômetro ao vivo, podendo informar quando foi atingido com um toque em **`💀 FUI ATINGIDO! (MARCAR K.I.A.)`**.

---

## 2. Passo a Passo para o Juiz (Anfitrião da Partida)

### Passo 1: Configurar Times e Alistar Operadores (`🪖 ALISTAMENTO`)
* Na tela principal, você pode editar o **Nome do Time A** e do **Time B** (ex: `ALPHA`, `BRAVO`, `DELTA`, `MERCENÁRIOS`) e escolher uma das **6 Cores Táticas** (Azul, Vermelho, Amarelo, Verde, Laranja, Roxo).
* Clique em **`🪖 ALISTAMENTO`** no cabeçalho para:
  * Digitar o nome/codinome de cada soldado e adicioná-lo ao Time A ou Time B.
  * Usar o botão **`⇄ TROCAR`** para transferir um jogador de time ou **`✕`** para removê-lo.
  * Clicar em **`🎲 SORTEAR / EQUILIBRAR TIMES`** para embaralhar todos os jogadores e dividir os esquadrões automaticamente de forma justa.
* *Dica:* Se quiser jogar uma partida rápida sem cadastrar nomes, basta ajustar a quantidade inicial de jogadores usando os botões gigantes **`(+)`** e **`(−)`** no painel de cada time.

### Passo 2: Escolher o Modo de Jogo e Tempo de Preparação
No painel central (**Cronômetro**), selecione o modo de operação:
* **`⏱️ TIME LIMIT` (Modo Tempo):**
  * Partida com contagem regressiva configurável em minutos (botões `-1 MIN` e `+1 MIN`).
  * A partida termina automaticamente quando o tempo chega a `00:00` **OU** quando um dos times chega a `0` jogadores vivos.
* **`💀 ELIMINATION` (Mata-Mata Progressivo):**
  * Sem limite de tempo. O cronômetro conta de `00:00` para cima apenas para medir a duração do combate.
  * A partida termina automaticamente quando todos os integrantes de um time são eliminados (`0` vivos) ou quando o juiz clica em **`🏁 FINALIZAR / CONFERIR VIVOS`**.
* **Tempo de Preparação (`-15s`, `0s OFF`, `+15s`):**
  * Define quantos segundos os times têm para se posicionar em campo antes do combate valer.

### Passo 3: Iniciar o Combate e Sinais Sonoros
1. Toque em **`▶️ INICIAR PARTIDA`**.
2. Se houver tempo de preparação configurado (ex: `30s`), o painel ficará **laranja piscante** com o alerta *"⚠️ ASSUMAM SUAS POSIÇÕES"*:
   * Acima de 10 segundos: Toca um **bipe duplo a cada 15 segundos** (60s, 45s, 30s, 15s).
   * Nos últimos 10 segundos (`10s` até `1s`): Toca um **bipe por segundo**, subindo o tom nos 3 segundos finais.
   * Caso todos já estejam prontos, o juiz pode tocar em **`⚡ PULAR PREPARAÇÃO`**.
3. Quando a preparação zera, dispara o **impacto sonoro grave + sirene curta** e o locutor anuncia com voz grave: **`"Kill them all!"`**.

### Passo 4: Controle Durante o Combate e Conferência Pós-Partida
* Durante o jogo, sempre que um operador sair atingido, toque no **crachá com o nome dele** (ou no botão `− BAIXA`) — ou deixe que o próprio jogador toque em **`💀 FUI ATINGIDO!`** no celular dele.
* Quando o tempo esgotar ou um time zerar, a sirene toca com o anúncio **`"Game Over!"`** e abre automaticamente o **Modal de Conferência Tática de Sobreviventes**:
  * Se um time perdeu por eliminação total, todos os seus soldados já aparecem marcados como **💀 MORREU (K.I.A.)**.
  * Faça qualquer ajuste necessário clicando nos nomes dos operadores ou nos botões rápidos (*"💀 Todos Mortos (0)"* / *"🛡️ Todos Vivos"*).
  * O vencedor do round (ou **EMPATE TÁTICO**) é calculado em tempo real no topo.
  * Clique em **`✅ CONFIRMAR RESULTADO E PONTUAR`** para somar `+1` vitória ao vencedor e salvar as estatísticas individuais no Hall of Fame.

---

## 3. Passo a Passo para os Jogadores (No Celular)
1. Abra o link enviado pelo Juiz no WhatsApp (ou abra o app e clique em **`☁️ SESSÃO ONLINE`**).
2. No card **Entrar em Sessão Existente**:
   * Confirme o **Código da Sala**.
   * Digite seu **Codinome de Operador** (ex: `GHOST`).
   * Escolha seu esquadrão (**Time A** ou **Time B**) e toque em **`📲 ENTRAR E ALISTAR-SE`**.
3. Na tela principal, aparecerá o seu **HUD do Operador** no topo:
   * Quando for atingido durante a partida, toque no botão vermelho **`💀 FUI ATINGIDO! (MARCAR K.I.A.)`**.
   * O placar de vivos do seu time será atualizado instantaneamente para o Juiz e para todos os jogadores!

---

## 4. Relatório Geral, Hall of Fame (`🏆 RELATÓRIO`) e Instalação PWA
* **Hall of Fame ("Quem Mais Ficou Vivo"):** Toque em **`🏆 RELATÓRIO`** no cabeçalho para ver o placar acumulado do dia e o ranking dos operadores ordenado pelo número de sobrevivências e taxa `% de sobrevivência`. O 1º colocado recebe a insígnia dourada **`🥇 IMORTAL`**.
* **Exportar para WhatsApp:** Clique em **`📋 COPIAR RELATÓRIO PARA WHATSAPP`** para copiar o resumo completo formatado com emojis e colar no grupo da equipe.
* **Instalar o Aplicativo (PWA):**
  * **Android / Desktop (Chrome/Edge):** Clique no botão **`📲 INSTALAR APP`** no topo da tela.
  * **iPhone / iPad (Safari):** Toque no botão **Compartilhar** (ícone de quadrado com seta para cima) e selecione **"Adicionar à Tela de Início"**.
