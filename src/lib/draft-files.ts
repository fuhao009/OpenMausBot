import {
  handoffAttachmentImagePreview,
  imageAttachmentFromFile,
  imageSlotsLeft,
  intakeFiles,
  optimisticImageAttachment,
  releaseAttachmentImagePreview,
  type Attachment,
} from "./composer-attachments";
import { appendDraftAttachments, changeDraftAttachmentPending, getDraftAttachmentsFor, replaceDraftAttachment } from "./drafts";

/** The image shows in the draft at once and is swapped for the uploaded one when it lands; a failed upload leaves
 * nothing behind. Returns null: the draft already holds the image. */
export async function uploadImageToDraft(draftId: string, file: File): Promise<Attachment | null> {
  const optimistic = optimisticImageAttachment(file);
  if (!optimistic) return null;
  appendDraftAttachments(draftId, [optimistic]);
  try {
    const completed = await imageAttachmentFromFile(file, optimistic);
    if (!completed) {
      replaceDraftAttachment(draftId, optimistic.id, null);
      releaseAttachmentImagePreview(optimistic);
      return null;
    }
    handoffAttachmentImagePreview(completed.path, completed.previewUrl);
    if (!replaceDraftAttachment(draftId, optimistic.id, completed)) releaseAttachmentImagePreview(completed);
    return null;
  } catch (error) {
    replaceDraftAttachment(draftId, optimistic.id, null);
    releaseAttachmentImagePreview(optimistic);
    throw error;
  }
}

/** Files picked or dropped for a draft, whether or not its composer is on screen. Returns the notice for what was
 * left out, if anything. */
export async function addFilesToDraft(draftId: string, files: readonly File[], { allowImages, getPath }: {
  allowImages: boolean;
  getPath: (file: File) => string;
}): Promise<string | null> {
  if (!files.length) return null;
  changeDraftAttachmentPending(draftId, true);
  try {
    const { attachments, notice } = await intakeFiles(files, {
      allowImages,
      getPath,
      uploadImage: (file) => uploadImageToDraft(draftId, file),
      imageSlots: imageSlotsLeft(getDraftAttachmentsFor(draftId)),
    });
    appendDraftAttachments(draftId, attachments);
    return notice;
  } finally {
    changeDraftAttachmentPending(draftId, false);
  }
}
