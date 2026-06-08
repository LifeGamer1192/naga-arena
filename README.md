# NAGA ARENA

ブラウザで即座に遊べる、リアルタイム対戦ヘビゲーム。サーバー権威方式（ゲームロジックは全てサーバーで処理）。

> **Phase 1 (MVP)** — このリポジトリの現在地点。
> WebSocket接続 / Battle Royale モードのみ / フードのみ。

## 特徴（Phase 1）

- **サーバー権威方式**: 全ゲーム判定をサーバー側で実行（チート対策）。クライアントは入力送信と描画のみ。
- **Battle Royale**: 最後の1匹まで生き残れ。フードを食べて体長とスコアを伸ばす。
- **WebSocketリアルタイム同期**: 20 tick/sec でステートをブロードキャスト。
- **PC / スマホ対応**: 矢印キー・WASD / スワイプ・タッチD-pad。
- **スコア計算**: フードコンボ倍率・生存ボーナス・キル報酬・順位補正。

## 必要環境

- Node.js 20+

## セットアップと起動

```bash
npm install
npm start
```

ブラウザで http://localhost:3000 を開く。複数タブ／複数端末で開くと対戦になります。

- `ENTER ARENA` → ロビーへ
- 全員 `READY` で 3..2..1 → ゲーム開始（1人でも練習プレイ可能）

## 操作

| 操作 | PC | モバイル |
| --- | --- | --- |
| 移動 | 矢印キー / WASD | スワイプ / 画面下のD-pad |

※ 現在の進行方向と逆向きへの入力は無効（即死防止）。

## 技術スタック

| 層 | 技術 |
| --- | --- |
| フロントエンド | HTML5 Canvas, Vanilla JS (ES2022), WebSocket API |
| バックエンド | Node.js 20+, ws, Express |

## アーキテクチャ

```
Browser Clients ──WebSocket(入力 / ステート)──> Node.js Game Server
                                                  └ GameRoom（50ms ループ）
```

- サーバーループ: 50ms 間隔でステートをブロードキャスト。
- 蛇のステップ: `STEP_MS`（既定 130ms）ごとに1セル前進。
- 衝突判定: 壁 / 胴体（自他）/ ヘッドオン / すれ違い。

## ディレクトリ構成

```
naga_arena/
├── package.json
├── server/
│   ├── server.js   # Express + ws、メインループ、ブロードキャスト
│   └── game.js     # GameRoom: 移動・衝突・スコア・勝利判定
└── public/
    ├── index.html  # 画面（TITLE / LOBBY / GAME / RESULT）
    ├── style.css
    └── client.js   # WebSocketクライアント・Canvas描画・入力
```

## ロードマップ

| フェーズ | 内容 | 状態 |
| --- | --- | --- |
| Phase 1 | MVP: WebSocket・Battle Royale・フードのみ | ✅ 実装済み |
| Phase 2 | URL共有ルーム・全アイテム・4マップ・全モード・モバイル最適化 | 予定 |
| Phase 3 | Rankedモード・レーティング・リーダーボード・観戦 | 予定 |
| Phase 4 | スキン・SE・大会モード・本番デプロイ | 予定 |

## ライセンス

MIT
