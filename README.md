# P2P Chat (Electron + Trystero)

Um **"Discord descentralizado"**: servidores → canais (texto e voz), com vídeo,
câmera, tela e voz **totalmente P2P**, sem nenhum servidor próprio. O signaling
(o "encontro" entre os peers) usa **trackers BitTorrent** públicos (via WSS) através
de [Trystero](https://github.com/dmotz/trystero); a mídia vai direto de peer a peer
via WebRTC.

Veja o [TODO.md](TODO.md) para o roadmap (identidade por keypair, administração de
servidores, persistência local-first/CRDT, presença e escala).

## Estrutura da UI (três colunas)

- **Servidores** (rail à esquerda): cada servidor é um manifesto local (nome, ícone,
  canais). Crie com **+** ou entre por **🔗 convite** (código base64 do manifesto).
- **Canais**: cada servidor tem canais de **texto** (`#`) e de **voz** (`🔊`).
  Cada canal vira uma sala Trystero derivada (`spaceId:channelId`).
- **Conteúdo**: canal de texto mostra o chat; canal de voz mostra o palco de vídeo.
  A **voz persiste** enquanto você navega pelos canais de texto (barra "Voz conectada").

> Estado atual: **identidade por keypair** (ECDSA P-256, chave privada
> não-extraível no IndexedDB); servidores/canais e preferências em `localStorage`;
> sem histórico persistente ainda (M4).

## Identidade (M2)

Na 1ª vez, o app gera um par de chaves **ECDSA P-256**. A chave privada é
**não-extraível** e fica no IndexedDB (`identity.js`) — assina, mas não pode ser
exportada por JS. A **chave pública** é a identidade estável do usuário; o apelido
é só conteúdo por cima dela (dois usuários podem ter o mesmo apelido, mas nunca a
mesma chave). Ao entrar numa sala (voz ou texto), cada peer envia um **handshake
assinado** provando posse da chave — o selo **✓** indica identidade/assinatura
verificada. As mensagens de texto também são assinadas e verificadas.

## Administração de servidores (M3 — em andamento)

Servidores criados pelo usuário têm um **dono criptográfico**: o `spaceId` é
`hash(chave_pública_do_dono + nonce)` (único e atrelado ao dono), e o manifesto
(nome, ícone, canais) é **assinado** pelo dono e **versionado**. Ao entrar num
canal, os peers trocam o manifesto por gossip P2P e adotam a **maior versão válida
assinada pelo dono** — assim novos canais propagam sem servidor central.

- **Só o dono edita** (decisão de projeto): criar canais fica restrito a ele; peers
  apenas recebem e verificam. O servidor público **Daggerfall** (sem dono) é um
  espaço legado editável localmente, sem verificação.
- **Convites são verificados**: um manifesto com assinatura adulterada é rejeitado.
- **Moderação é cooperativa**: banir (a implementar) significa que clientes honestos
  escondem/recusam a chave banida — sem coerção criptográfica por ora.

> Trocar a estratégia de signaling é uma linha em `renderer/index.js`
> (`trystero/torrent`, `trystero/nostr`, `trystero/mqtt`). O default é `torrent`
> porque os relays **nostr** rejeitam eventos quando o relógio da máquina está
> fora de sincronia (erro `created_at too early` / `ephemeral event expired`).

## Rodar

```bash
npm install
npm start        # faz o build do renderer e abre o Electron
```

Durante o desenvolvimento, em dois terminais:

```bash
npm run watch    # rebuild automático do renderer ao salvar
npm run dev      # abre o Electron (sem rebuild)
```

## Testar

1. Abra o app em **duas máquinas** (ou duas instâncias). Na 1ª vez, escolha um apelido.
2. Os dois entram no mesmo servidor **Daggerfall** por padrão. Para um servidor
   privado: um cria (**+**), copia o convite (menu **⌄** → Copiar convite) e o outro
   entra pelo **🔗**.
3. Cliquem no canal de voz **🔊 Sala de Voz** → **Entrar na voz**. Ativem câmera/tela.
4. Troquem mensagens nos canais de texto (`#geral`, `#random`).

## Gerar executável Windows

```bash
npm run pack:win
```

Gera `release/P2P Chat-win32-x64/` (app desempacotado, ~265 MB). Zipe a pasta e
envie para outra pessoa — ela só extrai e roda `P2P Chat.exe`, sem instalar nada.

> Usamos **@electron/packager** (não electron-builder) de propósito: o
> electron-builder baixa o `winCodeSign`, que exige criação de symlinks e falha
> no Windows sem **Modo de Desenvolvedor**. O packager apenas copia o runtime, sem
> assinatura. O `.exe` não é assinado, então o SmartScreen mostrará um aviso
> ("Mais informações" → "Executar assim mesmo").

## Testar entre redes diferentes

O signaling (torrent) funciona pela internet sem configuração. Para a **mídia**,
o WebRTC tenta conexão direta usando os servidores **STUN** públicos já
configurados no `rtcConfig` (`renderer/index.js`). Isso cobre a maioria das redes
domésticas. Se um dos lados estiver atrás de **NAT simétrico** ou **CGNAT** (comum
em 4G/5G e alguns provedores), a conexão direta falha e é necessário um servidor
**TURN** (retransmite a mídia) — o único ponto que não dá para eliminar 100% sem
infra.

### Configurar TURN

> A interface de TURN está **oculta por enquanto** (o bloco `#turnSection` em
> `index.html` tem `display: none`). O mecanismo continua no código: para
> reativar, basta remover esse `display: none`. A lista final de `iceServers`
> (STUN fixos + TURN opcional) é montada em `buildIceServers()`.

## Como funciona

- `trystero/torrent` → descoberta de peers e signaling, sem servidor seu.
- `room.addStream(stream, targets, {kind})` / `onPeerStream(stream, id, {kind})`
  → mic, câmera e tela são streams **independentes**, distinguidos pelo metadado
  `kind` (`'mic'` | `'camera'` | `'screen'`). Ativar um não desliga o outro.
- `room.makeAction('chat')` / `('nick')` → texto e apelidos (RTCDataChannel).
- `desktopCapturer` + `setDisplayMediaRequestHandler` (main.js) → seletor de janela/tela.

### UI

- Entrada automática na sala **daggerfall** ao abrir, já **conectado em voz**.
- Botão de microfone alterna mudo/ativo (liga/desliga a faixa de áudio local).
- Câmera e tela têm botões próprios, independentes.
- Clique em qualquer vídeo (o seu ou de um peer) para **focá-lo no palco**; os
  demais ficam em miniatura no filmstrip horizontal abaixo. Telas compartilhadas
  ganham foco automático ao surgir.
- **Picture-in-Picture**: botão ⧉ em cada vídeo (aparece no hover) ou o botão
  global **⧉ PiP** nos controles, que prioriza a tela compartilhada. Telas têm
  `autoPictureInPicture`: ao trocar o foco para outra janela, a tela do peer
  entra em PiP flutuante automaticamente.
- **Bandeja de participantes** (estilo Discord): todos os presentes aparecem no
  filmstrip inferior. Quem está sem câmera é mostrado como um **avatar circular**
  com a inicial do apelido (cor derivada do id). Quem está falando ganha uma
  **borda verde** por detecção de voz (VAD via Web Audio API — `AnalyserNode`).
  O palco espelha o participante/tela em foco, então ninguém sai da bandeja.
- **Configurações** (botão ⚙): escolha de **microfone** e **saída de áudio**
  (`setSinkId`), **volume de saída**, medidor de nível do mic ao vivo, e filtros
  nativos do Chromium — **supressão de ruído**, cancelamento de eco e ganho
  automático (constraints do `getUserMedia`). Trocar de mic ou filtro re-adquire
  o stream em tempo real. Preferências ficam salvas em `localStorage`.

## Limitações conhecidas

- **Topologia mesh**: cada peer envia sua mídia para todos os outros. Ótimo para
  1:1 e grupos pequenos (~4-6). Grupos maiores saturam o upload — aí seria preciso
  um SFU (o que reintroduz um servidor de mídia).
- **NAT simétrico**: ~10-20% das redes bloqueiam a conexão direta e exigem um
  servidor **TURN** de retransmissão. O Trystero usa STUN público por padrão; para
  produção, configure `relayUrls`/`rtcConfig` com um TURN (ex.: coturn).
- Relays nostr públicos podem ter latência/indisponibilidade variável. Dá para
  trocar a estratégia (`trystero/torrent`, `trystero/mqtt`) ou apontar relays fixos.
