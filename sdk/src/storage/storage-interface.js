/**
 * @file storage-interface.js
 * @description IStorage abstract interface — all storage implementations must follow this contract.
 * Zero external dependencies.
 */

export class IStorage {
  /** @param {string} key @returns {Promise<*>} */
  // eslint-disable-next-line no-unused-vars
  async get(key) { throw new Error('IStorage.get() must be implemented'); }

  /** @param {string} key @param {*} value @returns {Promise<void>} */
  // eslint-disable-next-line no-unused-vars
  async set(key, value) { throw new Error('IStorage.set() must be implemented'); }

  /** @param {string} key @returns {Promise<void>} */
  // eslint-disable-next-line no-unused-vars
  async delete(key) { throw new Error('IStorage.delete() must be implemented'); }

  /** @returns {Promise<string[]>} */
  async keys() { throw new Error('IStorage.keys() must be implemented'); }

  /** @returns {Promise<void>} */
  async clear() { throw new Error('IStorage.clear() must be implemented'); }
}

export default IStorage;
