### class TransactionDaemon<TContext = any>

#### constructor(opts: { db: MongoDB.Db, transactionsCollectionName?: string })

Creates a new instance of the daemon.

#### register(methodID: string, method: TransactionalMethod<TContext>): void

Registers a method.

#### start(): void

Starts the daemon. Processes any remaining transactions first before new ones.

#### async invoke<TArg = any, TResult = any>(methodID: string, ...args: TArg[]): Promise<TResult>

Invokes a transaction. All arguments must be MongoDB-serializable.

Enqueues a transaction, waits for it to finish, and returns its result.

#### async enqueueTransaction<TArg = any>(methodID: string, process: boolean, ...args: TArg[]): Transaction

Enqueues a transaction. All arguments must be MongoDB-serializable.

### interface TransactionalMethod<TContext>

A registration contract for a transactional process.

#### lockOnCollections: { [collection: string]: { read?: boolean; write?: boolean } }

Collections that need to be locked.
Concurrent access won't be provided for two `TransactionalMethod`s with the same collection locks.

#### plan(context: PlanInfo<TContext>, ...transactionArgs: any[]): Iterable<(c: TransactionInfo<TContext>) => Promise<void>>

Lay out the transaction execution plan based on the method arguments.

### interface Transaction

#### \_id: ObjectID

#### method: string

#### args: any[]

#### resumeIndex: number

#### mdate: Date

#### data: { [key: string]: any }

#### result?: any

#### errorMessage?: string

#### done: boolean

### interface TransactionInfo<TContext>

#### async setData(key: string, value: any): Promise<void>

Save custom data in the transaction. Data must be MongoDB-serializable.

#### async setResult(result: any): Promise<void>

Set the transaction result. Note that the containing function must still be exited manually. Data must be MongoDB-serializable.

#### readonly data: { [key: string]: any }

Load custom data in the transaction.

#### context: TContext

Custom context.

### PlanInfo<TContext>

#### context: TContext

Custom context.
