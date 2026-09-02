# CLAUDE.md

xCOMET MCP Server を触るときの指針。Claude Code / Cowork から読まれる。

## 日本語を書くとき

**`ja-writing-guide.md` を先に読む。** 書き終えたら用語集の左列を検索し、残っていたら右列に
置き換える。対象は `README.ja.md`、`tests/README.md`、`CHANGELOG.md`、および会話の回答文。

- 書く前の 3 つの確認（逆翻訳 / 錨 / 名前）を段落ごとに行う。
- 英語版の事実（バージョン、パス、環境変数名、数値）は変えない。変えるのは日本語の形だけ。
- 英語版に無い倍率・評価・推奨を足さない。
- 見出しの絵文字を英語版から日本語版へ機械コピーしない。
- 範囲は波ダッシュで書く（`3.9〜3.12`）。ハイフンと混在させない。
- 注記ラベルは 重要 / 注意 / 注記 / 補足 の 4 種。`Note` や `Tip` は使わない。

日付は **JST** で書く。実行環境の時計が UTC のことがあるため、`TZ=Asia/Tokyo date +%F` で
確認してから書く。`CHANGELOG.md` は npm の tarball にも入るので、publish 後は次の
バージョンまで直せない。

## この repo の形

- stdio 専用の MCP server。HTTP transport は v0.6.0 で削除した。
- Node（TypeScript）と Python の 2 層。両者は stdin / stdout 上の行区切り JSON-RPC で話す。
- 実行時依存は `@modelcontextprotocol/server` と `zod` の 2 つだけ。
- Python 側（`python/server.py`）は xCOMET モデルを読み込む常駐ワーカー。npm パッケージには
  このスクリプトしか入らない。Python 本体と `unbabel-comet` は利用者が用意する。

| パス | 役割 |
|---|---|
| `src/index.ts` | stdio の入口。`serveStdio(factory)` |
| `src/server.ts` | `createServer()`。入口とテストが共用する factory |
| `src/tools/index.ts` | ツール登録 |
| `src/schemas/index.ts` | 入出力スキーマ（zod） |
| `src/services/python-server.ts` | Python ワーカーの起動と監視 |
| `python/server.py` | 常駐ワーカー |
| `ja-writing-guide.md` | 日本語の用語と点検 |
| `tests/README.md` | 各テストスイートの対象 |

## 触る前に知っておくこと

- **Python ワーカーの stdout は JSON-RPC の通り道。** `print()` を stdout に出さない。ログは
  `log()`（stderr）を使う。Node 側も同じで、`console.log` は `no-console` で禁止している。
- **`model.predict()` には `num_workers` に 1 以上を渡す。** COMET は MPS 環境で
  `multiprocessing_context="fork"` を渡す一方、既定の `num_workers` は `2 * gpus` で CPU 推論では
  0 になる。torch はこの組み合わせを拒否する。`_num_workers()` の下限 1 がそれを避けている。
- **戻り値は `outputSchema` で検証されてから返る。** `python/server.py` が返すフィールドを
  増減したら `src/schemas/index.ts` も直す。食い違うとツール呼び出しそのものが失敗する。
  `tests/output-schemas.test.ts` がこの境界を見ている。
- **zod は 4.2.0 以上が必要。** それ未満だと `npm install` も `tsc` も通り、server は起動して
  接続まで成功し、最初の `tools/list` だけがエラーを返す。
- **モデルの重みは venv の中には入らない。** `~/.cache/huggingface/hub/` に入る。venv を
  作り直しても再度ダウンロードする必要はない。
- COMET の `Prediction` は自前の `ModelOutput` を継承していて、`__getitem__` は str 以外の
  キーで値の側を引く。`metadata[0]` はサンプル 0 のデータではない。`metadata["error_spans"]`
  を使う（`python/server.py` の `_error_spans()`）。

## コマンド

```bash
npm run build        # tsc && chmod +x dist/index.js
npm run typecheck
npm run lint
npm test             # Vitest
npm run test:python  # pytest。tests/test_server.py
npm run inspect      # MCP Inspector
```

`test:python` は PATH 上の `python3` から pytest が import できる必要がある。入っていなければ
`uvx pytest tests/test_server.py -q` でも実行できる。`comet` もモデルも不要。

## リリース

1. `CHANGELOG.md` に JST の日付で追記する。
2. `package.json` と `.claude-plugin/plugin.json` の version を揃える。
3. `git tag vX.Y.Z` を push する。`publish.yml` が lint → test → build → publish の順で走る
   （npm Trusted Publisher、OIDC + provenance）。version がタグと一致しないと止まる。

`publish.yml` は `test:python` を含まない。Python 側の検証は `ci.yml` の `python-tests` が行う。

## やらないこと

- 利用者の環境と OS が異なる場所から、このリポジトリの `node_modules` に対して
  `npm install` / `npm ci` を走らせない。optionalDependencies のネイティブバインディングが
  入れ替わり、相手側の `npm test` が動かなくなる。依存を変えるときは `package.json` の編集に
  とどめ、install は利用者に依頼する。
- `python/__pycache__` を残したまま publish しない。`package.json` の `files` が `"python"` と
  ディレクトリ指定のため、`.gitignore` は npm に効かない。
