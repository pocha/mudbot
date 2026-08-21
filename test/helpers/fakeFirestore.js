// Minimal in-memory fake of the tiny slice of the Firestore client API that
// services/leadsService.js actually uses:
//   db.collection('leads').doc(id).set(data, {merge:true})
//   db.collection('leads').doc(id).get()
//   db.collection('leads').doc(id).update(data)
//   db.collection('leads').doc(id).delete()
//   db.collection('leads').where('userDir','==',x).orderBy('updatedAt','desc').limit(n).get()
//
// Good enough to support these tests' scenarios only — not a general
// Firestore emulator.

function createFakeFirestore() {
  const store = new Map(); // collectionName -> Map<id, data>

  function getCollectionMap(name) {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name);
  }

  function makeDocSnapshot(id, data) {
    return {
      id,
      exists: data !== undefined,
      data: () => (data === undefined ? undefined : { ...data })
    };
  }

  function collection(name) {
    const docs = getCollectionMap(name);

    function doc(id) {
      return {
        async get() {
          return makeDocSnapshot(id, docs.get(id));
        },
        async set(data, opts = {}) {
          const existing = docs.get(id);
          if (opts.merge && existing) {
            docs.set(id, { ...existing, ...data });
          } else {
            docs.set(id, { ...data });
          }
          return undefined;
        },
        async update(data) {
          const existing = docs.get(id);
          if (!existing) throw new Error(`No document to update: ${id}`);
          docs.set(id, { ...existing, ...data });
          return undefined;
        },
        async delete() {
          docs.delete(id);
          return undefined;
        }
      };
    }

    function buildQuery(filters, order, limitN) {
      return {
        where(field, op, value) {
          if (op !== '==') throw new Error(`Fake firestore only supports '==', got '${op}'`);
          return buildQuery([...filters, { field, value }], order, limitN);
        },
        orderBy(field, direction = 'asc') {
          return buildQuery(filters, { field, direction }, limitN);
        },
        limit(n) {
          return buildQuery(filters, order, n);
        },
        async get() {
          let entries = [...docs.entries()];
          for (const f of filters) {
            entries = entries.filter(([, data]) => data[f.field] === f.value);
          }
          if (order) {
            entries.sort((a, b) => {
              const av = a[1][order.field];
              const bv = b[1][order.field];
              const cmp = av > bv ? 1 : av < bv ? -1 : 0;
              return order.direction === 'desc' ? -cmp : cmp;
            });
          }
          if (typeof limitN === 'number') entries = entries.slice(0, limitN);
          return { docs: entries.map(([id, data]) => makeDocSnapshot(id, data)) };
        }
      };
    }

    return {
      doc,
      ...buildQuery([], null, undefined)
    };
  }

  return { collection, _store: store };
}

module.exports = { createFakeFirestore };
