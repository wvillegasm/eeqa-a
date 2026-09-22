/**
 * @typedef {import('../../domain/entities/Study.js').Study} Study
 * @typedef {import('../../ports/IStudyRepository.js').IStudyRepository} IStudyRepository
 * @typedef {import('../../ports/IInfoServiceClient.js').IInfoServiceClient} IInfoServiceClient
 * @typedef {import('../../ports/IStorageService.js').IStorageService} IStorageService
 */

/**
 * Moves one study through PROCESSING to COMPLETED, streaming its T2T18 payload into storage.
 * Any failure after the study is loaded leaves it persisted as ERROR.
 */
export class ProcessStudyUseCase {
  #studyRepository;
  #infoServiceClient;
  #storageService;

  /**
   * @param {IStudyRepository} studyRepository
   * @param {IInfoServiceClient} infoServiceClient
   * @param {IStorageService} storageService
   */
  constructor(studyRepository, infoServiceClient, storageService) {
    this.#studyRepository = studyRepository;
    this.#infoServiceClient = infoServiceClient;
    this.#storageService = storageService;
  }

  /**
   * @param {string} studyId
   * @returns {Promise<Study>} The study in its final COMPLETED state.
   */
  async execute(studyId) {
    /** @type {Study | undefined} */
    let study;
    try {
      study = await this.#studyRepository.getStudyById(studyId);

      study.markAsProcessing();
      await this.#studyRepository.updateStudyStatus(study);

      const payload = await this.#infoServiceClient.fetchT2T18Data(study.ssn);
      await this.#storageService.uploadStream(`${study.id}.bin`, payload);

      study.markAsCompleted();
      await this.#studyRepository.updateStudyStatus(study);
      return study;
    } catch (error) {
      // A study that was never loaded has no status to record.
      if (study) {
        study.markAsError();
        try {
          await this.#studyRepository.updateStudyStatus(study);
        } catch (persistError) {
          console.error(`Failed to persist ERROR status for ${study.id}:`, persistError);
        }
      }
      throw error;
    }
  }
}
