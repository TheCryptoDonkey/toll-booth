// src/meter.ts
import Database from 'better-sqlite3'

export interface DebitResult {
  success: boolean
  remaining: number
}

export class CreditMeter {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credits (
        payment_hash TEXT PRIMARY KEY,
        balance INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
  }

  credit(paymentHash: string, amountSats: number): void {
    this.db.prepare(`
      INSERT INTO credits (payment_hash, balance)
      VALUES (?, ?)
      ON CONFLICT(payment_hash) DO UPDATE SET
        balance = balance + excluded.balance,
        updated_at = datetime('now')
    `).run(paymentHash, amountSats)
  }

  debit(paymentHash: string, amountSats: number): DebitResult {
    const current = this.balance(paymentHash)
    if (current < amountSats) {
      return { success: false, remaining: current }
    }
    this.db.prepare(`
      UPDATE credits SET balance = balance - ?, updated_at = datetime('now')
      WHERE payment_hash = ?
    `).run(amountSats, paymentHash)
    return { success: true, remaining: current - amountSats }
  }

  balance(paymentHash: string): number {
    const row = this.db.prepare(
      'SELECT balance FROM credits WHERE payment_hash = ?'
    ).get(paymentHash) as { balance: number } | undefined
    return row?.balance ?? 0
  }
}
