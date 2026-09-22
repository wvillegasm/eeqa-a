/**
 * Thrown by every port base method. Adapters must override the method.
 */
export class NotImplementedError extends Error {
  /**
   * @param {string} method - Qualified method name, e.g. `IStudyRepository.getStudyById`.
   */
  constructor(method) {
    super(`${method} is not implemented`);
    this.name = 'NotImplementedError';
  }
}
