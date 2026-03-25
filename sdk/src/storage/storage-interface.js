/**
 * IStorage — abstract interface for key-value item storage.
 * All implementations must fulfil this contract.
 */
export class IStorage {
  /**
   * Store an item.
   * @param {string} key
   * @param {*} value
   * @returns {Promise<void>}
   */
  async put(key, value) { throw new Error('Not implemented'); }

  /**
   * Retrieve an item by key.
   * @param {string} key
   * @returns {Promise<*|null>}
   */
  async get(key) { throw new Error('Not implemented'); }

  /**
   * Delete an item.
   * @param {string} key
   * @returns {Promise<void>}
   */
  async delete(key) { throw new Error('Not implemented'); }

  /**
   * Return all items as an array of { key, value, updatedAt } objects.
   * @param {{ since?: number }} [opts]
   * @returns {Promise<Array<{key:string, value:*, updatedAt:number}>>}
   */
  async getAll(opts = {}) { throw new Error('Not implemented'); }

  /**
   * Return the count of stored items.
   * @returns {Promise<number>}
   */
  async count() { throw new Error('Not implemented'); }

  /**
   * Clear all stored items.
   * @returns {Promise<void>}
   */
  async clear() { throw new Error('Not implemented'); }
}
