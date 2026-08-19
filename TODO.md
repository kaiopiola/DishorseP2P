# Roadmap — P2P Chat → "Discord descentralizado"

Decisões já tomadas:
- **Arquitetura**: Servidores (spaces) → canais (texto/voz)
- **Persistência**: local-first (CRDT), com opção futura de nó "always-on"
- **Identidade**: chave criptográfica (keypair) persistente
- **Signaling**: Trystero/torrent (serverless), STUN público; TURN oculto por ora

---

## ✅ Base concluída
- [x] Voz/vídeo/tela P2P mesh (testado em call com vários, entre redes)
- [x] Chat de texto, bandeja de participantes, avatares, indicador de voz (VAD)
- [x] Picture-in-Picture (foco em tela)
- [x] Configurações: mic, saída, volume, filtros de ruído
- [x] Gate de apelido obrigatório na 1ª vez
- [x] Build Windows (@electron/packager) + STUN entre redes

## ✅ Milestone 1 — Shell estilo Discord (CONCLUÍDO)
- [x] Camada de dados: servidores/canais/convites (`store.js`)
      > NOTA: hoje o `id` do servidor é um genId placeholder. Evoluir para um
      > **hash único e estável** (o nome vira só conteúdo editável por cima).
      > Ideal: id derivado da chave pública do criador (ex.: hash(pubkey+nonce)),
      > garantindo unicidade E amarrando o dono — casa com identidade/admin (M2/M3).
- [x] Layout três colunas: servidores | canais | conteúdo
- [x] Rail de servidores (selecionar, criar, entrar por convite)
- [x] Lista de canais por servidor (texto + voz), criar canal
- [x] Canais de texto: chat por canal (troca de canal = troca de sala)
- [x] Canais de voz: entrar/sair; voz persiste ao navegar em canais de texto
- [x] Barra "conectado em voz" com desconectar
- [x] Convite: copiar código do servidor / entrar por código

### Limitações conhecidas do M1 (endereçar depois)
- Trocar de canal de texto sai da sala anterior → mensagens só chegam no canal
  aberto (resolvido no M4 com CRDT + rooms em background)
- Presença em canal de voz só aparece para quem está conectado nele (M5)
- Sem histórico persistente ainda (M4)

## ✅ Milestone 2 — Identidade criptográfica (CONCLUÍDO)
- [x] Gerar keypair local na 1ª vez — ECDSA P-256, privada NÃO-EXTRAÍVEL no
      IndexedDB (`identity.js`); persiste entre reinícios
- [x] Perfil atrelado à chave pública: cor do avatar e fingerprint derivados do
      `pub` (estáveis entre sessões)
- [x] Handshake assinado por sala (voz e texto): prova posse da chave; impossível
      forjar o `pubId` de outro
- [x] Mensagens de texto assinadas e verificadas no recebimento
- [x] Selos: ✓ identidade/assinatura verificada, ⚠ não verificada
- [ ] (futuro) Avatar de imagem customizado atrelado à identidade
- [ ] (futuro) Anti-replay com nonce por conexão no handshake
- [ ] (futuro) Backup/exportação da identidade entre dispositivos

## 🛡️ Milestone 3 — Administração de servidores (EM ANDAMENTO)
Decisões tomadas:
- **Autoridade**: SÓ O DONO edita o manifesto (mais simples, sem conflito).
- **Aplicação**: cooperativa (clientes honestos respeitam; sem coerção cripto por ora).
- **Começar por**: dono + id-hash + manifesto assinado.

- [x] `spaceId` = hash(pubkey_do_dono + nonce) — id único atrelado ao dono
- [x] Manifesto com `owner`, `nonce`, `version`, `sig` (assinado pelo dono)
- [x] Verificar manifesto no recebimento (assinatura + id derivado do dono)
- [x] Propagação P2P (gossip): adota maior versão válida assinada pelo dono
- [x] Edição restrita ao dono (criar canal já gated; servidor público sem dono é local)
- [x] Convite verificado (rejeita manifesto com assinatura inválida)
- [x] Remover/renomear canal e renomear servidor (dono) na UI — hover ✎/✕ nos
      canais + menu do servidor; reassina e propaga
- [x] **Banir/remover usuários do servidor (só dono)** — botão ✕ na lista da call;
      adiciona a chave a `banned`, reassina e propaga; clientes honestos escondem os
      banidos e o próprio banido sai do servidor ao receber o manifesto (cooperativo)
- [x] Desbanir (remover de `banned`) na UI — menu do servidor → Gerenciar banidos
- [ ] (futuro) Papéis (dono/admin/membro) — admins adicionais assinados pelo dono
      > MUDA a decisão "só o dono edita"; requer nova discussão de autoridade
- [ ] (futuro) Transferência de propriedade
- [ ] (futuro) Dono offline: co-admins / quórum
> M3 ESSENCIAL concluído. Restantes marcados (futuro) mexem no modelo de autoridade.
> Servidor legado "Daggerfall" (sem dono) segue como espaço público local, sem
> verificação de manifesto.

## ✨ Polimento de UX
- [x] **Ícones de status na lista da call** (estilo Discord): 🔇 mudo, 📷 câmera,
      🖥️ tela — via action 'state' {muted, cam, screen}, broadcast a cada mudança
- [ ] Ícone de fala/anel também no stage grande (hoje só borda)
- [x] **Mutar SAÍDA de áudio** (surdo) — mute em todos os <audio> remotos; ícone
      🙉 no estado; persiste como config de entrada
- [x] **Toggles de mic e saída na me-bar** (ao lado da engrenagem) — pré-config
      antes de entrar na call; salvos em localStorage (micMuted/deafened)
- [x] **Lista de quem está assistindo minha tela** — receptor sinaliza (action
      'watch') ao focar/desfocar; emissor mostra "👁 N" + nomes no tile da tela
- [x] **Chat de texto lateral (colapsável) no canal de voz** — botão 💬 na topbar;
      cada canal de voz tem sua sala de chat própria ('vchat:'), assinada/verificada

## 🖥️ Desktop / janela
- [x] Desativar o menu superior padrão do Electron
- [ ] (ver seção "Segundo plano & inicialização")

## 👤 Perfil & mídia
- [x] **Avatar de imagem** personalizado — upload → WebP 128px quadrado (canvas
      toDataURL); atrelado à identidade e propagado no handshake (ident)
- [x] **Bio de perfil** até 100 caracteres — modal de perfil (editar o meu ao
      clicar na me-info; ver o de outro ao clicar no membro da call)
- [x] Editar apelido no próprio modal de perfil
- [x] **Envio de imagens no chat** (texto e chat da voz) — 📎 anexa imagem,
      converte para WebP ≤1280px, assina (texto+img) e envia; Trystero faz o
      chunking do payload; thumbnail no chat + visualizador em tela cheia

## 💬 Mensagens diretas / conversas privadas
- [x] DM 1:1 — sala derivada de hash(chaves ordenadas); botão 📨 no rail abre a
      lista de DMs; "Enviar mensagem" no perfil de um membro inicia a conversa
- [x] Lista de conversas privadas (localStorage) separada dos servidores
- [x] Assinadas/verificadas como os canais (transporte P2P via DTLS)
- [ ] (futuro) E2E com ECDH (hoje qualquer um que conheça as 2 chaves poderia
      entrar na sala; restringir ao peer esperado + cifrar com chave derivada)
- [ ] (futuro) imagens/histórico nas DMs já funcionam (reusam o chat); faltam
      notificações e grupos privados

## 🎚️ Qualidade & performance de transmissão
- [x] **Seleção de qualidade** (resolução máx.) e **limite de FPS** nas
      configurações; aplicado a câmera e tela via constraints de captura E via
      RTCRtpSender.setParameters (maxBitrate/maxFramerate). Default: 720p/30fps.
      Muda ao vivo (applyConstraints) sem reabrir a transmissão.
- [ ] Perfis rápidos (ex.: "Economia de dados") e indicador de bitrate atual
- [x] **Preview borrado das transmissões de tela**: telas dos outros aparecem
      como poster borrado + "▶ assistir" no filmstrip (sem <video> ao vivo, não
      decodifica); só a tela em foco toca no palco. A própria tela abre sozinha.
      Poster = frame congelado ao sair de foco (canvas). Marca "no ar" na ativa.
- [ ] (futuro) Reduzir também a BANDA das telas não assistidas: sinalizar ao
      emissor "não estou assistindo" para ele pausar/baixar o envio (mesh não
      reduz banda sozinho; hoje só o decode é evitado)

## 💾 Milestone 4 — Persistência local-first (CRDT)
- [ ] Histórico de texto por canal com CRDT (Yjs/Automerge) sobre data channel
- [ ] Sincronização/gossip ao reconectar (recuperar o que perdeu offline)
- [ ] Armazenamento local do histórico (IndexedDB)
- [ ] (Opcional) nó "de fixação" headless para ancorar histórico/presença

## 🌐 Milestone 5 — Presença e descoberta
- [ ] Presença: quem está em cada canal de voz sem precisar entrar
- [ ] Lista de membros do servidor (online/offline)
- [ ] Notificações (menções, mensagens novas)

## 📈 Milestone 6 — Escala
- [ ] Avaliar limite do mesh (~6-8) e caminho para grupos grandes
- [ ] SFU seletivo / camada de retransmissão (reintroduz nó de mídia?)
- [ ] TURN próprio para NAT simétrico/CGNAT (UI já existe, oculta)

## 🪟 Segundo plano & inicialização
- [x] **Rodar em segundo plano** — fechar minimiza para a bandeja (Tray) com menu
      Abrir/Sair; padrão ligado; toggle nas configurações
- [x] **Iniciar com o Windows** (na bandeja) — app.setLoginItemSettings com
      --hidden; janela começa oculta quando iniciada assim; toggle nas configs
- [x] Instância única (requestSingleInstanceLock) reabre a janela existente
- [x] Ícone gerado programaticamente (scripts/make-icon.js → assets/icon.png)
- [ ] (futuro) ícone .ico para o exe no empacotamento Windows

## 🐞 Estabilidade / conexão
- [~] **Dessincronização ao entrar** (ID no lugar do nome; mensagens não aparecem
      para alguns) — MITIGADO: handshake de identidade agora responde ao receber
      e tem retry defensivo (antes só anunciava 1x no onPeerJoin)
- [ ] Investigar conexões mesh meio-abertas (ICE) que só normalizam ao sair/voltar;
      avaliar health-check + re-tentativa de conexão, e reannounce periódico

## 🎨 Transversais
- [ ] Responsividade e temas
- [ ] Empacotar builds atualizados (Win) a cada marco
- [ ] Testes com amigos a cada milestone
