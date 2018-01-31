import { ObjectID, Collection, Db } from 'mongodb'
import { EventEmitter } from 'events'
import Mutex from '@seangenabe/mutex'
import pMap = require('p-map')

/**
 * MongoDB transactions helper.
 */
export class TransactionDaemon<TContext = any> {
  public context: TContext
  private methods: Map<string, TransactionalMethod<TContext>>
  private ee: EventEmitter
  private _publicEvents: EventEmitter
  private tc: Collection<Transaction>
  private accessQueues: Map<string, { read: Mutex; write: Mutex }>

  public get publicEvents() {
    return this._publicEvents
  }

  /**
   * Creates a new instance of the daemon.
   */
  constructor(opts: { db: Db; transactionsCollectionName?: string }) {
    const { db, transactionsCollectionName = 'transactions' } = opts

    this.methods = new Map<string, TransactionalMethod<TContext>>()
    this.accessQueues = new Map<string, { read: Mutex; write: Mutex }>()
    const ee = new EventEmitter()
    ee.setMaxListeners(20000)
    this.ee = ee
    this._publicEvents = new EventEmitter()
    this.tc = db.collection(transactionsCollectionName)
  }

  /**
   * Starts the daemon. Processes any remaining transactions first before new ones.
   */
  public start(): void {
    ;(async () => {
      const { tc } = this
      // Read all transactions.
      const transactionObjs = await tc
        .find({ done: false })
        .sort({ mdate: 1 })
        .toArray()
      for (let t of transactionObjs) {
        this.processTransaction(t)
      }
    })()
  }

  /**
   * Registers a method.
   */
  public register(
    methodID: string,
    method: TransactionalMethod<TContext>
  ): void {
    const { methods } = this
    if (methods.has(methodID)) {
      throw new Error('Method already registered.')
    }
    methods.set(methodID, method)
  }

  public async invoke<T1 = any, TResult = any>(methodID: string, arg1: T1)
  public async invoke<T1 = any, T2 = any, TResult = any>(
    methodID: string,
    arg1: T1,
    arg2: T2
  )
  public async invoke<T1 = any, T2 = any, T3 = any, TResult = any>(
    methodID: string,
    arg1: T1,
    arg2: T2,
    arg3: T3
  )

  /**
   * Invokes a transaction. All arguments must be MongoDB-serializable.
   */
  public async invoke<TArg = any, TResult = any>(
    methodID: string,
    ...args: TArg[]
  ): Promise<TResult> {
    const { ee } = this
    const t = this.enqueueTransaction<TArg>(methodID, true, ...args)
    // Wait for transaction dequeue.
    const result = await new Promise<TResult>((resolve, reject) => {
      ee.on(
        'transactionDequeued',
        (
          transactionID: ObjectID,
          errorMessage: string,
          result: TResult,
          err: any
        ) => {
          if (t._id.equals(transactionID)) {
            if (err) {
              reject(err)
              return
            }
            if (errorMessage) {
              reject(errorMessage)
              return
            }
            resolve(result)
          }
        }
      )
    })
    return result
  }

  /**
   * Enqueues a transaction. All arguments must be MongoDB-serializable.
   */
  public enqueueTransaction<TArg = any>(
    methodID: string,
    process: boolean,
    ...args: TArg[]
  ): Transaction {
    const { tc } = this
    const t: Transaction = {
      _id: new ObjectID(),
      method: methodID,
      args,
      mdate: new Date(),
      resumeIndex: 0,
      data: {},
      done: false
    }
    ;(async () => {
      await tc.insertOne(t)
      if (process) {
        await this.processTransaction(t)
      }
    })()
    return t
  }

  private getCollectionAccessQueue(
    collectionName: string,
    mode: 'read' | 'write'
  ): Mutex {
    const { accessQueues } = this
    if (accessQueues.has(collectionName)) {
      let x = accessQueues.get(collectionName) as {
        read: Mutex
        write: Mutex
      }
      return x[mode]
    }
    const x = { read: new Mutex(), write: new Mutex() }
    accessQueues.set(collectionName, x)
    return x[mode]
  }

  private async processTransaction(t: Transaction): Promise<void> {
    const { methods, publicEvents, tc, ee } = this
    // Get transaction method registration.
    const method = methods.get(t.method)
    let err: Error | undefined
    if (method == null) {
      publicEvents.emit(
        'error',
        new Error(`Unknown transaction method: ${t.method}`)
      )
      return
    }
    // Request collection access.
    const accessQueues: Mutex[] = []
    await pMap(
      Object.entries(method.lockOnCollections),
      async ([collectionName, x]) => {
        await pMap(Object.entries(x), async ([mode, active]) => {
          if (active) {
            const access = await this.getCollectionAccessQueue(
              collectionName,
              mode as 'read' | 'write'
            )
            accessQueues.push(access)
          }
        })
      }
    )
    const data = t.data
    const locks: (() => void)[] = await pMap(accessQueues, (m: Mutex) =>
      m.wait()
    )

    // Create transaction plan.
    const planContext: PlanInfo<TContext> = {
      context: this.context
    }

    // Plan execution.
    const executionPlan = [...method.plan(planContext, ...t.args)]

    // Resume execution.
    let { resumeIndex } = t

    /** Tracks promises made inside a transaction execution. */

    const contextFn = (m: Mutex) =>
      ({
        async setResult(result: any) {
          t.result = result
          const r = await m.wait()
          await tc.findOneAndUpdate({ _id: t._id }, { $set: { result } })
          r()
        },
        get data() {
          return data
        },
        async setData(key: string, value: any) {
          data[key] = value
          const r = await m.wait()
          await tc.findOneAndUpdate(
            { _id: t._id },
            { $set: { [`data.${key}`]: value } }
          )
          r()
        },
        context: this.context
      } as TransactionInfo<TContext>)
    if (t.errorMessage == null) {
      for (let len = executionPlan.length; resumeIndex < len; ) {
        // Run plan on index.
        try {
          const m = new Mutex()
          const context = contextFn(m)
          await executionPlan[resumeIndex](context)
          // Wait for all transaction promises.
          ;(await m.wait())()
          // Update transaction index
          resumeIndex++
          await tc.updateOne({ _id: t._id }, { $set: { resumeIndex } })
        } catch (e) {
          err = e
          t.errorMessage = e.message
          await tc.updateOne(
            { _id: t._id },
            { $set: { errorMessage: e.message } }
          )
          break
        }
      }
    }

    // Release locks
    for (let lock of locks) {
      lock()
    }
    await ee.emit('transactionDequeued', t._id, t.errorMessage, t.result, err)
    await tc.updateOne({ _id: t._id }, { $set: { done: true } })
  } // processTransaction
}

export default TransactionDaemon

/**
 * A registration contract for a transactional process.
 */
export interface TransactionalMethod<TContext> {
  /**
   * Collections that need to be locked.
   * Concurrent access won't be provided for two `TransactionalMethod`s with
   * the same collection locks.
   */
  lockOnCollections: {
    [collection: string]: { read?: boolean; write?: boolean }
  }
  /**
   * Lay out the transaction execution plan based on the method arguments.
   * Must be deterministic.
   */
  plan(
    context: PlanInfo<TContext>,
    ...transactionArgs: any[]
  ): Iterable<(c: TransactionInfo<TContext>) => Promise<void>>
}

export interface Transaction {
  _id: ObjectID
  method: string
  args: any[]
  resumeIndex: number
  mdate: Date
  data: { [key: string]: any }
  result?: any
  errorMessage?: string
  done: boolean
}

export interface TransactionInfo<TContext> {
  /**
   * Save custom data in the transaction. Data must be MongoDB-serializable.
   */
  setData(key: string, value: any): Promise<void>
  /**
   * Set the transaction result. Note that the containing function must still be exited manually. Data must be MongoDB-serializable.
   */
  setResult(result: any): Promise<void>
  /**
   * Load custom data in the transaction.
   */
  readonly data: { [key: string]: any }
  /**
   * Custom context.
   */
  context: TContext
}

export interface PlanInfo<TContext> {
  /**
   * Custom context.
   */
  context: TContext
}
