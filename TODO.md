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

## 🔑 Milestone 2 — Identidade criptográfica
- [ ] Gerar keypair local na 1ª vez (guardar com segurança no userData)
- [ ] Perfil = apelido + avatar atrelados à chave pública
- [ ] Assinar mensagens; verificar assinatura no recebimento
- [ ] Exibir identidade verificada (evitar spoofing de apelido)

## 🛡️ Milestone 3 — Administração de servidores  ← DISCUTIR ANTES DE IMPLEMENTAR
> Quem cria o servidor precisa ser admin. Provável: dono = keypair criadora.
- [ ] Dono do servidor = chave pública de quem criou (no manifesto)
- [ ] Papéis/permissões (admin, moderador, membro)
- [ ] Ações administrativas assinadas (criar/remover canal, kick, ban)
- [ ] Como propagar/validar mudanças no manifesto sem servidor central?
      (manifesto assinado pelo dono; membros verificam a assinatura)
- [ ] Transferência de propriedade / múltiplos admins
- [ ] Revisar: e se o dono nunca mais aparecer? (co-admins, quórum?)

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
