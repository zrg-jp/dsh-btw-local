# dsh-btw-local

DSH Web に Claude Code の `/btw` 相当の「横質問」を足すローカルプラグイン。

- 会話の文脈だけを使い、ツールは使わない
- 1 回だけ答える（会話履歴・セッションイベントには残らない）
- メインのターンを止めずに使える
- 開き方: 送信ボタン横の `btw` チップ、または入力欄に `/btw 質問`

## なぜ既製の dsh-btw を使わないか（0.2.0-rc.2 で確認）

npm の `dsh-btw@0.0.3`（MIT, iluluyu）は 0.2.0-rc.2 では動かない。根拠:

1. **RPC の取り付け先が無い** — `connection.rpc.intercept("/api", …)` は 1 チャネル 1 本
   しか登録できず（`dsh-client-connection` の `registerInterceptor` が重複で throw）、
   `/api` は `dsh-api-gateway` が既に所有している。
2. **文脈の取り方が古い** — クライアントの `useSession()` に `nodes` は無い
   （SessionSnapshot はライフサイクルだけ。会話は view store 側）。
3. **一時チャットは別 API に依存** — `session.events` は廃止（`snapshotEvents()`）、
   子エージェントの合成は `$DSH_HOME/profiles/node_modules` を前提にしているが
   この環境には無い。

そのため、`/btw` の面だけを 0.2.0-rc.2 の契約で書き直した。ホスト側の文脈組み立てを
クライアントからホストへ移し、共有 `/api` チャネルに exact ルート `/api/btw-local.<endpoint>`（ask / poll / cancel）を登録する。
一時チャット機能は、上記の非互換と、ツール付き子エージェントを「履歴に残さない」形で
安全に焼却する設計が別途必要なため、いったん含めない。

## 仕組み

- クライアント: `conversation.input.dock` にパネル、`conversation.input.right` にチップ。
  `/btw ` プレフィックスは `inputActions.setDraft("")` で取り除き、質問だけパネルへ移す。
- ホスト: `ctx.agents.get(sessionId).session.snapshotEvents()` から
  `user/message` / `assistant/message` のテキストを直近 14 行・48KB まで拾い、
  `llm.stream()` に 1 回だけ渡す。ジョブはメモリ上だけ（TTL 10 分）、保存しない。
- モデルは設定の既定モデル（`agentDefaultModel.currentSelection()`）。ツールは渡さない。

## インストール

```sh
ln -s "$(pwd)/dsh-btw-local" ~/.dsh/local-plugins/dsh-btw-local
```

`~/.dsh/profiles/web/cordis.patch.yml` に追記する:

```yaml
- insert:
    - id: btw-local
      name: /Users/<user>/.dsh/local-plugins/dsh-btw-local/lib/index.js
```

その後 `dsh web` を再起動してページをリロードする（ホストのプラグイン一覧は起動時に読む）。

ホスト側は `connection.fetch.register()` で `/api/btw-local.*` を登録する。専用チャネル（`connection.rpc.handle()`）はプラグインから登録できず 405 になるため、2026-11-06 に切り替えた。

## 検証

- 構文: `node --check lib/index.js lib/client.js`
- ルート登録と封筒は `dsh-usage-local/test/integration.test.js`（DSH 本体の rpc.call・/api 振り分けとの結合）で確かめる。文脈抽出・LLM 呼び出しの自動テストは無い。

## セキュリティ

- `/api/btw-local.*` は `/api` ルートの Host/Origin 検査とブラウザ認証を通る（cookie）。認可はブラウザ単位で、
  ライブな任意セッションの文脈を読める。この GUI は同じ利用者が全セッションを閲覧できる前提なので、セッションの所有者は確かめない。
- 文脈は「そのホストでライブなセッション」のイベントだけ。保存も送信もしない（LLM への
  1 リクエストを除く）。
- ツールを渡さないので、横質問がファイルを読んだりコマンドを実行したりはしない。
