export type Priority = 'urgent' | 'high' | 'medium' | 'low' | 'none'
export type Status = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled'

export interface Issue {
  id: string
  identifier: string
  title: string
  status: Status
  priority: Priority
  assignee: string | null
  labels: string[]
  project: string
  createdAt: string
  updatedAt: string
  description: string
}

const names = ['田中太郎', '鈴木花子', '佐藤健', '山田美咲', '高橋翔']
const projects = ['Tachyon Core', 'Tachyon UI', 'API Gateway', 'Auth Service']
const labelSets = [
  ['bug'], ['feature'], ['improvement'], ['bug', 'critical'],
  ['feature', 'ux'], ['infra'], ['docs'], ['performance'],
]

const titles: Record<Status, string[]> = {
  backlog: [
    'ダッシュボードのレスポンシブ対応',
    'E2Eテストの追加',
    'ログ出力フォーマットの統一',
    'API Rate Limitの実装',
    'WebSocket接続のリトライ機能',
  ],
  todo: [
    'ユーザー検索APIの実装',
    'テーブルビューのフィルタ機能',
    'メール通知テンプレートの作成',
    'バッチ処理のエラーハンドリング改善',
    'OpenAPI定義の更新',
  ],
  in_progress: [
    'カンバンビューのドラッグ&ドロップ実装',
    '認証フローのリファクタリング',
    'パフォーマンスモニタリングの導入',
    'GraphQLスキーマの設計',
  ],
  in_review: [
    'CI/CDパイプラインの最適化',
    'データベースマイグレーションスクリプト',
    'アクセス制御の権限モデル実装',
  ],
  done: [
    'プロジェクト設定画面の実装',
    'Slack連携の通知機能',
    'CSVエクスポート機能',
    'ダークモード対応',
    '多言語対応(i18n)の基盤構築',
    'パスワードリセットフロー',
  ],
  cancelled: [
    'レガシーAPI v1の廃止',
    '旧UIコンポーネントの削除',
  ],
}

const priorities: Priority[] = ['urgent', 'high', 'medium', 'low', 'none']

const extraTitles = [
  'キャッシュ戦略の見直し', 'エラー画面のUX改善', 'ヘルスチェックAPIの追加',
  'バックアップ自動化', 'セッション管理の改善', 'ページネーションの最適化',
  'ファイルアップロード機能', 'Webhook配信リトライ', 'メトリクス収集基盤',
  '通知設定画面', 'データエクスポート改善', 'API v2設計', 'テスト基盤の刷新',
  'ロギング基盤の刷新', 'マルチテナント対応', 'SSO連携', '監査ログ実装',
  '検索インデックス最適化', 'レート制限の高度化', 'データ整合性チェック',
]

let counter = 1
const statuses: Status[] = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled']

function generateIssues(): Issue[] {
  const issues: Issue[] = []
  // Original titles by status
  for (const [status, titleList] of Object.entries(titles)) {
    for (const title of titleList) {
      issues.push(makeIssue(title, status as Status))
    }
  }
  // Extra issues for virtual scroll testing (200+ total)
  for (let i = 0; i < 180; i++) {
    const title = `${extraTitles[i % extraTitles.length]} #${Math.floor(i / extraTitles.length) + 2}`
    const status = statuses[i % statuses.length]
    issues.push(makeIssue(title, status))
  }
  return issues
}

function makeIssue(title: string, status: Status): Issue {
  const id = `issue-${counter}`
  const identifier = `PLT-${100 + counter}`
  const issue: Issue = {
    id,
    identifier,
    title,
    status,
    priority: priorities[counter % priorities.length],
    assignee: counter % 3 === 0 ? null : names[counter % names.length],
    labels: labelSets[counter % labelSets.length],
    project: projects[counter % projects.length],
    createdAt: new Date(2026, 2, (counter % 28) + 1).toISOString(),
    updatedAt: new Date(2026, 2, 20 + (counter % 10)).toISOString(),
    description: `${title}の詳細な説明がここに入ります。\n\n## 要件\n- 要件1\n- 要件2\n- 要件3\n\n## 関連\n- ${identifier}`,
  }
  counter++
  return issue
}

export const mockIssues: Issue[] = generateIssues()

export const statusConfig: Record<Status, { label: string; color: string; icon: string }> = {
  backlog: { label: 'Backlog', color: 'var(--text-muted)', icon: '○' },
  todo: { label: 'Todo', color: 'var(--status-todo)', icon: '◎' },
  in_progress: { label: 'In Progress', color: 'var(--status-progress)', icon: '◑' },
  in_review: { label: 'In Review', color: 'var(--accent)', icon: '◕' },
  done: { label: 'Done', color: 'var(--status-done)', icon: '●' },
  cancelled: { label: 'Cancelled', color: 'var(--status-cancelled)', icon: '⊘' },
}

export const priorityConfig: Record<Priority, { label: string; color: string; icon: string }> = {
  urgent: { label: 'Urgent', color: 'var(--priority-urgent)', icon: '⚡' },
  high: { label: 'High', color: 'var(--priority-high)', icon: '▲' },
  medium: { label: 'Medium', color: 'var(--priority-medium)', icon: '■' },
  low: { label: 'Low', color: 'var(--priority-low)', icon: '▽' },
  none: { label: 'None', color: 'var(--text-muted)', icon: '─' },
}
