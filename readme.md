# mongodb-transaction-daemon

MongoDB transaction helper.

## Usage

```typescript
import { TransactionDaemon } from 'mongodb-transaction-daemon'
const daemon = new TransactionDaemon()
const users = db.collection('users')
// Register a method.
daemon.register('awesomeInTwoSteps', {
  lockOnCollections: {
    users: {
      read: true,
      write: true
    }
  },
  *plan(context, _id, first, second) {
    // The generator function is merely a convenience.
    // We need to be able to resume execution at any point.
    // Do not put MongoDB operations in the planning phase.
    yield async c => {
      await users.updateOne({ _id }, { a: first })
    }

    yield async c => {
      await users.updateOne({ _id }, { a: second })
      await c.setResult('ok')
    }
  }
})
// Invoke.
await daemon.invoke('awesomeInTwoSteps', 1, 2) // ok
```

See the [API](./api.md).
