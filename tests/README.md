# xCOMET MCP Server テストドキュメント

このドキュメントでは、xCOMET MCP Server のテストスイートについて説明します。

## テスト概要

```mermaid
graph TD
    subgraph "テストスイート"
        A[npm test] --> B[Vitest]
        B --> C[line-buffer.test.ts]
        B --> D[stop-race-condition.test.ts]
        B --> E[integration.test.ts]
        B --> F[user-scenarios.test.ts]
    end

    subgraph "テスト対象"
        C --> G[ポート検出<br/>チャンク処理]
        D --> H[stop関数<br/>レース条件]
        E --> I[Pythonサーバー<br/>統合テスト]
        F --> J[利用者視点<br/>シナリオテスト]
    end

    subgraph "カテゴリ"
        G --> K["Fix #1: stdout分割"]
        H --> L["Fix #2: start()呼出回避"]
        I --> M["Fix #3,4: ポート/統計"]
        J --> N["エッジケース/品質/性能"]
    end
```

## テストファイル一覧

| ファイル | テスト数 | 種別 | 対象 |
|---------|---------|------|------|
| `line-buffer.test.ts` | 9 | ユニット | TypeScript |
| `stop-race-condition.test.ts` | 5 | ユニット | TypeScript |
| `integration.test.ts` | 5 | 統合 | Python + TypeScript |
| `user-scenarios.test.ts` | 28 | E2E | 利用者シナリオ |
| **合計** | **47** | - | - |

---

## 1. 行バッファリングテスト (`line-buffer.test.ts`)

### 問題の背景

Python サーバーはポート番号を JSON 形式で stdout に出力します。しかし、パイプバッファリングにより出力が複数チャンクに分割される可能性があります。

```mermaid
sequenceDiagram
    participant P as Python Server
    participant B as stdout Buffer
    participant N as Node.js

    P->>B: {"por
    Note over B: チャンク1
    B->>N: {"por
    P->>B: t": 12345}
    Note over B: チャンク2
    B->>N: t": 12345}
    Note over N: 行バッファで結合して<br/>JSON.parse成功
```

### テストケース

| テスト名 | 説明 |
|---------|------|
| `should parse complete JSON in single chunk` | 単一チャンクでの正常パース |
| `should handle JSON split across multiple chunks` | 複数チャンクに分割されたJSONの処理 |
| `should handle JSON with preceding log output` | ログ出力が先行する場合 |
| `should handle multiple lines in single chunk` | 1チャンクに複数行が含まれる場合 |
| `should handle chunk boundary in the middle of JSON` | JSON途中でのチャンク分割 |
| `should ignore incomplete JSON at end of stream` | 不完全なJSONの無視 |
| `should handle empty chunks` | 空チャンクの処理 |
| `should handle Windows-style line endings` | CRLF改行コードの処理 |
| `should handle no port in output` | ポート情報がない場合 |

### 行バッファリングアルゴリズム

```mermaid
flowchart TD
    A[データ受信] --> B[バッファに追加]
    B --> C[改行で分割]
    C --> D{未完了の行?}
    D -->|Yes| E[バッファに保持]
    D -->|No| F[各行を処理]
    F --> G{JSON?}
    G -->|Yes| H{portあり?}
    G -->|No| I[デバッグログ]
    H -->|Yes| J[ポート取得完了]
    H -->|No| I
    I --> K[次の行へ]
    K --> F
```

---

## 2. stop() レース条件テスト (`stop-race-condition.test.ts`)

### 問題の背景

修正前の `stop()` メソッドは `request()` を経由して `/shutdown` を呼び出していました。`request()` は内部で `start()` を呼ぶため、停止処理中に新しいサーバーが起動する問題がありました。

```mermaid
sequenceDiagram
    participant U as User
    participant M as Manager
    participant S as Server

    rect rgb(255, 200, 200)
        Note over U,S: 修正前（バグあり）
        U->>M: stop()
        M->>M: request("/shutdown")
        M->>M: start() が呼ばれる!
        M->>S: 新サーバー起動
        M->>S: /shutdown
    end

    rect rgb(200, 255, 200)
        Note over U,S: 修正後
        U->>M: stop()
        M->>S: 直接 fetch("/shutdown")
        Note over M: start()は呼ばれない
    end
```

### テストケース

| テスト名 | 説明 |
|---------|------|
| `fixed stop() should not call start() when server is running` | 実行中サーバー停止時にstart()が呼ばれない |
| `fixed stop() should not call start() when server is not running` | 未実行時にstart()が呼ばれない |
| `buggy stop() would call start() unnecessarily` | 修正前のバグ動作を確認 |
| `fixed stop() should handle missing port gracefully` | ポートなしでも安全に停止 |
| `fixed stop() should skip shutdown request when no process` | プロセスなしでスキップ |

### 修正のポイント

```mermaid
flowchart LR
    subgraph "修正前"
        A1[stop] --> B1[request]
        B1 --> C1[start]
        C1 --> D1[fetch]
    end

    subgraph "修正後"
        A2[stop] --> D2[直接fetch]
    end
```

---

## 3. 統合テスト (`integration.test.ts`)

### テスト対象

実際の Python サーバーを起動して、エンドポイントの動作を検証します。

```mermaid
flowchart TD
    subgraph "統合テストフロー"
        A[Python サーバー起動] --> B[ポート取得]
        B --> C[エンドポイントテスト]
        C --> D[/health]
        C --> E[/stats]
        C --> F[/shutdown]
        D --> G[レスポンス検証]
        E --> G
        F --> G
        G --> H[サーバー停止]
    end
```

### テストケース

| テスト名 | 説明 |
|---------|------|
| `should start server and report port via stdout` | サーバー起動とポート報告 |
| `should respond to health check after startup` | ヘルスチェック応答 |
| `should return stats with new field names` | 新統計フィールドの確認 |
| `should shutdown gracefully via /shutdown endpoint` | グレースフルシャットダウン |
| `should have server.py in python directory` | server.py の存在確認 |

### 統計フィールドの変更

```mermaid
graph LR
    subgraph "修正前"
        A1[evaluation_count]
        A2[batch_count]
    end

    subgraph "修正後"
        B1[evaluate_api_count]
        B2[detect_errors_api_count]
        B3[batch_api_count]
        B4[total_pairs_evaluated]
    end

    A1 -.->|分離| B1
    A1 -.->|分離| B2
    A2 -.->|名称変更| B3
```

---

## 4. 利用者シナリオテスト (`user-scenarios.test.ts`)

### テスト概要

実際の利用者視点でのエンドツーエンドテストです。xCOMET モデルを使用した品質評価の実際の動作を検証します。

```mermaid
graph TD
    subgraph "1. 境界値・エッジケース"
        A1[空文字列]
        A2[長文テキスト]
        A3[特殊文字・絵文字]
        A4[コードブロック]
        A5[HTMLタグ]
        A6[改行・空白]
    end

    subgraph "2. 言語ペア"
        B1[ja → en/de/fr/es/it]
        B2[en → ja]
        B3[zh → en]
        B4[ko → en]
    end

    subgraph "3. エラーハンドリング"
        C1[null値]
        C2[必須フィールド欠落]
        C3[不正なJSON]
        C4[大量バッチ]
    end

    subgraph "4. 品質検証"
        D1[明らかな誤訳]
        D2[訳抜け]
        D3[不自然な訳]
        D4[正確な訳]
        D5[エラー検出API]
    end

    subgraph "5. パフォーマンス"
        E1[連続リクエスト]
        E2[並列リクエスト]
        E3[応答時間安定性]
        E4[高負荷耐性]
    end
```

### テストケース一覧

#### 1. 境界値・エッジケース (6テスト)

| テスト名 | 説明 | タイムアウト |
|---------|------|------------|
| `should handle empty strings gracefully` | 空文字列の処理 | 90秒 |
| `should handle very long text` | 長文（900文字+）の処理 | 120秒 |
| `should handle special characters and emojis` | `🚀 @user #tag $100` など | - |
| `should handle code blocks in text` | `` `map()` `` などのコード | - |
| `should handle HTML tags in text` | `<code>` タグなど | - |
| `should handle newlines and whitespace` | 改行・タブの処理 | - |

#### 2. 言語ペア (8テスト)

| 言語ペア | ソース例 | 翻訳例 |
|---------|---------|-------|
| ja → en | こんにちは | Hello |
| ja → de | こんにちは | Hallo |
| ja → fr | こんにちは | Bonjour |
| ja → es | こんにちは | Hola |
| ja → it | こんにちは | Ciao |
| en → ja | Hello | こんにちは |
| zh → en | 你好 | Hello |
| ko → en | 안녕하세요 | Hello |

#### 3. エラーハンドリング (5テスト)

| テスト名 | 期待するステータス |
|---------|------------------|
| `should reject null source` | 400 or 422 |
| `should reject missing translation field` | 400 or 422 |
| `should handle invalid JSON gracefully` | 400 or 422 |
| `should handle batch with maximum pairs (500)` | 200 |
| `should reject batch exceeding maximum pairs` | 200, 400, 413, or 422 |

#### 4. 品質検証シナリオ (5テスト)

```mermaid
graph LR
    subgraph "入力"
        A1["非同期処理"] --> B1["synchronous processing"]
        A2["RxJSは強力で柔軟なライブラリです"] --> B2["RxJS is a library"]
        A3["購読を解除する"] --> B3["cancel the subscription following"]
        A4["ユーザー認証が完了しました"] --> B4["User authentication completed"]
    end

    subgraph "検証"
        B1 --> C1["誤訳検出"]
        B2 --> C2["訳抜け検出"]
        B3 --> C3["不自然さ検出"]
        B4 --> C4["高スコア期待"]
    end
```

#### 5. パフォーマンス・安定性 (4テスト)

| テスト名 | 説明 |
|---------|------|
| `should handle sequential requests` | 10件の連続リクエスト |
| `should handle concurrent requests` | 5件の並列リクエスト |
| `should maintain stable response times` | 応答時間の標準偏差を測定 |
| `should recover from rapid requests` | 20件の高速リクエスト後の復旧 |

### パフォーマンス指標（参考値）

```
Sequential requests: avg=584ms, min=573ms, max=608ms
Concurrent requests (5): total=2916ms
Stability: avg=591ms, stdDev=19ms
```

> **Note**: 上記の値は環境により大きく異なります。初回リクエストはモデルロード時間（25-90秒）がかかります。

---

## テストの実行方法

### 全テスト実行

```bash
npm test
```

### ウォッチモードで実行

```bash
npm run test:watch
```

### 特定のテストファイルのみ実行

```bash
npx vitest run tests/line-buffer.test.ts
```

### カバレッジ付きで実行

```bash
npx vitest run --coverage
```

---

## テストの前提条件

### Node.js 側

- Node.js 18.0.0 以上
- `npm install` で依存関係をインストール済み

### Python 側（統合テスト用）

- Python 3.8 以上
- 以下のパッケージがインストール済み:
  - `fastapi`
  - `uvicorn`

```bash
pip install fastapi uvicorn
```

---

## テストアーキテクチャ

```mermaid
graph TB
    subgraph "テストレイヤー"
        UT[ユニットテスト]
        IT[統合テスト]
    end

    subgraph "テストフレームワーク"
        V[Vitest]
    end

    subgraph "テスト対象コード"
        TS[TypeScript<br/>python-server.ts]
        PY[Python<br/>server.py]
    end

    V --> UT
    V --> IT
    UT --> TS
    IT --> TS
    IT --> PY
```

---

## CI/CD での実行

GitHub Actions などで実行する場合の例:

```yaml
- name: Run tests
  run: |
    npm ci
    pip install fastapi uvicorn
    npm test
```

---

## トラブルシューティング

### 統合テストがスキップされる

Python の依存関係がインストールされていない場合、統合テストは自動的にスキップされます。

```bash
# 依存関係をインストール
pip install fastapi uvicorn
```

### ポートが既に使用中のエラー

テストは毎回ランダムなポートを使用しますが、まれにポート競合が発生する場合があります。テストを再実行してください。

### タイムアウトエラー

サーバーの起動に時間がかかる環境では、`vitest.config.ts` の `testTimeout` を調整してください。
