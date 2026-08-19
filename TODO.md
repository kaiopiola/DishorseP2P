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
- [ ] Remover/renomear canal e renomear servidor (dono) na UI
- [x] **Banir/remover usuários do servidor (só dono)** — botão ✕ na lista da call;
      adiciona a chave a `banned`, reassina e propaga; clientes honestos escondem os
      banidos e o próprio banido sai do servidor ao receber o manifesto (cooperativo)
- [ ] Desbanir (remover de `banned`) na UI
- [ ] Papéis (dono/admin/membro) — admins adicionais assinados pelo dono
- [ ] (futuro) Transferência de propriedade
- [ ] (futuro) Dono offline: co-admins / quórum
> Servidor legado "Daggerfall" (sem dono) segue como espaço público local, sem
> verificação de manifesto.

## ✨ Polimento de UX
- [x] **Ícones de status na lista da call** (estilo Discord): 🔇 mudo, 📷 câmera,
      🖥️ tela — via action 'state' {muted, cam, screen}, broadcast a cada mudança
- [ ] Ícone de fala/anel também no stage grande (hoje só borda)

## 👤 Perfil & mídia (novo)
- [ ] **Avatar de imagem** personalizado, atrelado à identidade
      > Converter para **WebP** e comprimir no envio (canvas.toBlob('image/webp', q));
      > redimensionar (ex.: máx 256px) para manter leve. Propagar no handshake.
- [ ] **Bio de perfil** até ~100 caracteres (exibir no perfil/hover)
- [ ] **Envio de imagens no chat de texto**
      > Também converter para WebP + comprimir/redimensionar antes de enviar pelo
      > data channel; assinar como as mensagens de texto. Cuidar do tamanho (chunk
      > se necessário) e de limites de payload do Trystero.

## 💬 Mensagens diretas / conversas privadas (novo)
- [ ] DM 1:1 entre dois usuários (sala derivada das duas chaves públicas)
- [ ] Lista de conversas privadas separada dos servidores
- [ ] Assinadas/verificadas como os canais (o transporte já é E2E via DTLS)
- [ ] (futuro) grupos privados (DM em grupo)

## 🎚️ Qualidade & performance de transmissão (novo)
- [ ] **Seleção de qualidade** (resolução) e **limite de FPS** por transmissão
      (câmera/tela), para o usuário não forçar sempre o máximo
      > Aplicar via constraints (width/height/frameRate) no getUserMedia/
      > getDisplayMedia E via RTCRtpSender.setParameters (maxBitrate/maxFramerate/
      > scaleResolutionDownBy). Guardar preferência nas configurações.
- [ ] **Preview borrado das transmissões de tela** em vez de abrir o vídeo de
      todos automaticamente; usuário clica para assistir e alterna entre elas
      > Não anexar o <video> ao DOM enquanto não assistido = não decodifica
      > (economiza CPU). Mostrar thumbnail/frame congelado borrado. Bandwidth
      > ainda flui no mesh; reduzir de verdade exigiria pausar track/simulcast
      > (avaliar sinalizar "quero/não quero receber" ao emissor).

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

## 🎨 Transversais
- [ ] Responsividade e temas
- [ ] Empacotar builds atualizados (Win) a cada marco
- [ ] Testes com amigos a cada milestone
