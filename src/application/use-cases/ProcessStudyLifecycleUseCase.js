/**
 * @typedef {import('../../ports/IInfoServiceClient.js').IInfoServiceClient} IInfoServiceClient
 * @typedef {import('../../ports/IStorageService.js').IStorageService} IStorageService
 * @typedef {import('../../ports/IStateStore.js').IStateStore} IStateStore
 * @typedef {import('../../ports/IStateStore.js').StateDocument} StateDocument
 */

/**
 * Moves one claimed study from P to R: fetches its payload from the info service,
 * streams it into artifact storage and records the artifact as ready.
 * Any failure leaves the study in E with the reason in its history.
 */
export class ProcessStudyLifecycleUseCase {
  #infoServiceClient;
  #storageService;
  #stateStore;

  /**
   * @param {IInfoServiceClient} infoServiceClient
   * @param {IStorageService} storageService
   * @param {IStateStore} stateStore
   */
  constructor(infoServiceClient, storageService, stateStore) {
    this.#infoServiceClient = infoServiceClient;
    this.#storageService = storageService;
    this.#stateStore = stateStore;
  }

  /**
   * @param {string} studyId
   * @param {string} ssn
   * @returns {Promise<StateDocument>} The state document in R.
   */
  async execute(studyId, ssn) {
    try {
      const payload = await this.#infoServiceClient.fetchT2T18Data(ssn);
      const artifact = await this.#storageService.saveArtifact(studyId, ssn, payload);
      return await this.#stateStore.markReady(studyId, artifact);
    } catch (error) {
      try {
        await this.#stateStore.markError(studyId, error instanceof Error ? error.message : String(error));
      } catch (persistError) {
        console.error(`Failed to persist E state for ${studyId}:`, persistError);
      }
      throw error;
    }
  }
}
