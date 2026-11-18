import type { DatabaseSync } from 'node:sqlite'

export type Phase = 'banning' | 'waiting' | 'pending' | 'verified' | 'unmuting' | 'kicking' | 'done' | 'left' | 'review'
export type Admission = {
  selfId: string
  groupId: string
  userId: string
  joinTime: number
  eventTime: number
  phase: Phase
  banUntil?: number
  deadline?: number
  reminded?: boolean
  failures: number
  digest?: string
  codeUntil?: number
  updated: number
}
export const admissionKey = (a: Pick<Admission, 'selfId' | 'groupId' | 'userId'>) => [a.selfId, a.groupId, a.userId].join(':')

export class AdmissionStore {
  readonly db: DatabaseSync
  constructor(db: DatabaseSync) {
    this.db = db
    db.exec(`
      CREATE TABLE IF NOT EXISTS admissions (
        key TEXT PRIMARY KEY,
        bot TEXT NOT NULL,
        member TEXT NOT NULL,
        phase TEXT NOT NULL,
        updated INTEGER NOT NULL,
        document TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS admissions_member ON admissions(bot, member);
      CREATE INDEX IF NOT EXISTS admissions_phase ON admissions(phase, updated);
    `)
  }
  get(key: string): Admission | undefined {
    const row = this.db.prepare('SELECT document FROM admissions WHERE key=?').get(key)
    return row ? JSON.parse(String(row.document)) : undefined
  }
  save(row: Admission): void {
    this.db.prepare(`INSERT INTO admissions (key,bot,member,phase,updated,document) VALUES (?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET phase=excluded.phase, updated=excluded.updated, document=excluded.document`)
      .run(admissionKey(row), row.selfId, row.userId, row.phase, row.updated, JSON.stringify(row))
  }
  byMember(bot: string, member: string): Admission[] {
    return this.db.prepare("SELECT document FROM admissions WHERE bot=? AND member=? AND phase IN ('waiting','pending','verified','review')")
      .all(bot, member).map(row => JSON.parse(String(row.document)))
  }
  active(): Admission[] {
    return this.db.prepare("SELECT document FROM admissions WHERE phase IN ('pending','verified','banning','unmuting','kicking')")
      .all().map(row => JSON.parse(String(row.document)))
  }
  prune(before: number): void {
    this.db.prepare("DELETE FROM admissions WHERE updated<? AND phase IN ('done','left')").run(before)
  }
}
