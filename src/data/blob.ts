import { nanoid } from "nanoid";
import { cleanAppStateForExport } from "../appState";
import { IMAGE_MIME_TYPES, MIME_TYPES } from "../constants";
import { clearElementsForExport } from "../element";
import { ExcalidrawElement, FileId } from "../element/types";
import { CanvasError } from "../errors";
import { t } from "../i18n";
import { calculateScrollCenter } from "../scene";
import { AppState, DataURL, LibraryItem } from "../types";
import { ValueOf } from "../utility-types";
import { bytesToHexString, isPromiseLike } from "../utils";
import { FileSystemHandle, nativeFileSystemSupported } from "./filesystem";
import { isValidExcalidrawData, isValidLibrary } from "./json";
import { restore, restoreLibraryItems } from "./restore";
import { ImportedLibraryData } from "./types";

const parseFileContents = async (blob: Blob | File) => {
  let contents: string;

  if (blob.type === MIME_TYPES.png) {
    try {
      return await (
        await import(/* webpackChunkName: "image" */ "./image")
      ).decodePngMetadata(blob);
    } catch (error: any) {
      if (error.message === "INVALID") {
        throw new DOMException(
          t("alerts.imageDoesNotContainScene"),
          "EncodingError",
        );
      } else {
        throw new DOMException(
          t("alerts.cannotRestoreFromImage"),
          "EncodingError",
        );
      }
    }
  } else {
    if ("text" in Blob) {
      contents = await blob.text();
    } else {
      contents = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.readAsText(blob, "utf8");
        reader.onloadend = () => {
          if (reader.readyState === FileReader.DONE) {
            resolve(reader.result as string);
          }
        };
      });
    }
    if (blob.type === MIME_TYPES.svg) {
      try {
        return await (
          await import(/* webpackChunkName: "image" */ "./image")
        ).decodeSvgMetadata({
          svg: contents,
        });
      } catch (error: any) {
        if (error.message === "INVALID") {
          throw new DOMException(
            t("alerts.imageDoesNotContainScene"),
            "EncodingError",
          );
        } else {
          throw new DOMException(
            t("alerts.cannotRestoreFromImage"),
            "EncodingError",
          );
        }
      }
    }
  }
  return contents;
};

export const getMimeType = (blob: Blob | string): string => {
  let name: string;
  if (typeof blob === "string") {
    name = blob;
  } else {
    if (blob.type) {
      return blob.type;
    }
    name = blob.name || "";
  }
  if (/\.(excalidraw|json)$/.test(name)) {
    return MIME_TYPES.json;
  } else if (/\.png$/.test(name)) {
    return MIME_TYPES.png;
  } else if (/\.jpe?g$/.test(name)) {
    return MIME_TYPES.jpg;
  } else if (/\.svg$/.test(name)) {
    return MIME_TYPES.svg;
  }
  return "";
};

export const getFileHandleType = (handle: FileSystemHandle | null) => {
  if (!handle) {
    return null;
  }

  return handle.name.match(/\.(json|excalidraw|png|svg)$/)?.[1] || null;
};

export const isImageFileHandleType = (
  type: string | null,
): type is "png" | "svg" => {
  return type === "png" || type === "svg";
};

export const isImageFileHandle = (handle: FileSystemHandle | null) => {
  const type = getFileHandleType(handle);
  return type === "png" || type === "svg";
};

export const isSupportedImageFile = (
  blob: Blob | null | undefined,
): blob is Blob & { type: ValueOf<typeof IMAGE_MIME_TYPES> } => {
  const { type } = blob || {};
  return !!type && (Object.values(IMAGE_MIME_TYPES) as string[]).includes(type);
};

export const loadSceneOrLibraryFromBlob = async (
  blob: Blob | File,
  /** @see restore.localAppState */
  localAppState: AppState | null,
  localElements: readonly ExcalidrawElement[] | null,
  /** FileSystemHandle. Defaults to `blob.handle` if defined, otherwise null. */
  fileHandle?: FileSystemHandle | null,
) => {
  const contents = await parseFileContents(blob);
  try {
    const data = JSON.parse(contents);
    if (isValidExcalidrawData(data)) {
      return {
        type: MIME_TYPES.excalidraw,
        data: restore(
          {
            elements: clearElementsForExport(data.elements || []),
            appState: {
              theme: localAppState?.theme,
              fileHandle: fileHandle || blob.handle || null,
              ...cleanAppStateForExport(data.appState || {}),
              ...(localAppState
                ? calculateScrollCenter(data.elements || [], localAppState)
                : {}),
            },
            files: data.files,
          },
          localAppState,
          localElements,
          { repairBindings: true, refreshDimensions: false },
        ),
      };
    } else if (isValidLibrary(data)) {
      return {
        type: MIME_TYPES.excalidrawlib,
        data,
      };
    }
    throw new Error(t("alerts.couldNotLoadInvalidFile"));
  } catch (error: any) {
    console.error(error.message);
    throw new Error(t("alerts.couldNotLoadInvalidFile"));
  }
};

export const loadFromBlob = async (
  blob: Blob,
  /** @see restore.localAppState */
  localAppState: AppState | null,
  localElements: readonly ExcalidrawElement[] | null,
  /** FileSystemHandle. Defaults to `blob.handle` if defined, otherwise null. */
  fileHandle?: FileSystemHandle | null,
) => {
  const ret = await loadSceneOrLibraryFromBlob(
    blob,
    localAppState,
    localElements,
    fileHandle,
  );
  if (ret.type !== MIME_TYPES.excalidraw) {
    throw new Error(t("alerts.couldNotLoadInvalidFile"));
  }
  return ret.data;
};

export const parseLibraryJSON = (
  json: string,
  defaultStatus: LibraryItem["status"] = "unpublished",
) => {
  const data: ImportedLibraryData | undefined = JSON.parse(json);
  if (!isValidLibrary(data)) {
    throw new Error("Invalid library");
  }
  const libraryItems = data.libraryItems || data.library;
  return restoreLibraryItems(libraryItems, defaultStatus);
};

export const loadLibraryFromBlob = async (
  blob: Blob,
  defaultStatus: LibraryItem["status"] = "unpublished",
) => {
  return parseLibraryJSON(await parseFileContents(blob), defaultStatus);
};

export const canvasToBlob = async (
  canvas: HTMLCanvasElement | Promise<HTMLCanvasElement>,
): Promise<Blob> => {
  return new Promise(async (resolve, reject) => {
    try {
      if (isPromiseLike(canvas)) {
        canvas = await canvas;
      }
      canvas.toBlob((blob) => {
        if (!blob) {
          return reject(
            new CanvasError(
              t("canvasError.canvasTooBig"),
              "CANVAS_POSSIBLY_TOO_BIG",
            ),
          );
        }
        resolve(blob);
      });
    } catch (error: any) {
      reject(error);
    }
  });
};

/** generates SHA-1 digest from supplied file (if not supported, falls back
    to a 40-char base64 random id) */
export const generateIdFromFile = async (file: File): Promise<FileId> => {
  try {
    const hashBuffer = await window.crypto.subtle.digest(
      "SHA-1",
      await blobToArrayBuffer(file),
    );
    return bytesToHexString(new Uint8Array(hashBuffer)) as FileId;
  } catch (error: any) {
    console.error(error);
    // length 40 to align with the HEX length of SHA-1 (which is 160 bit)
    return nanoid(40) as FileId;
  }
};

export const getDataURL = async (file: Blob | File): Promise<DataURL> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataURL = reader.result as DataURL;
      resolve(dataURL);
    };
    reader.onerror = (error) => reject(error);
    reader.readAsDataURL(file);
  });
};

export const dataURLToFile = (dataURL: DataURL, filename = "") => {
  const dataIndexStart = dataURL.indexOf(",");
  const byteString = atob(dataURL.slice(dataIndexStart + 1));
  const mimeType = dataURL.slice(0, dataIndexStart).split(":")[1].split(";")[0];

  const ab = new ArrayBuffer(byteString.length);
  const ia = new Uint8Array(ab);
  for (let i = 0; i < byteString.length; i++) {
    ia[i] = byteString.charCodeAt(i);
  }
  return new File([ab], filename, { type: mimeType });
};

export const resizeImageFile = async (
  file: File,
  opts: {
    /** undefined indicates auto */
    outputType?: typeof MIME_TYPES["jpg"];
    maxWidthOrHeight: number;
  },
): Promise<File> => {
  // SVG files shouldn't a can't be resized
  if (file.type === MIME_TYPES.svg) {
    return file;
  }

  const [Compressor] = await Promise.all([
    import("compressorjs").then((res) => res.default),
  ]);

  const compressFile = () =>
    new Promise<File | Blob>((resolve, reject) => {
      new Compressor(file, {
        maxHeight: opts.maxWidthOrHeight,
        maxWidth: opts.maxWidthOrHeight,
        quality: 0.8,
        // ...(file.size > 1024 * 1024 * 10 && {convertSize: 1024*10})
        //force default compress 5mb
        success(result) {
          resolve(result);
        },
        error(err) {
          console.error(err.message);
          reject(err);
        },
      });
    });

  if (!isSupportedImageFile(file)) {
    throw new Error(t("errors.unsupportedFileType"));
  }

  const compressedResult = await compressFile();
  const crf = new File([compressedResult], file.name, {
    type: file.size >= 5 * 1000 * 1000 ? "image/jpeg" : file.type,
  });

  return crf;
};

export const SVGStringToFile = (SVGString: string, filename: string = "") => {
  return new File([new TextEncoder().encode(SVGString)], filename, {
    type: MIME_TYPES.svg,
  }) as File & { type: typeof MIME_TYPES.svg };
};

export const ImageURLToFile = async (
  imageUrl: string,
  filename: string = "",
): Promise<File | undefined> => {
  let response;
  try {
    response = await fetch(imageUrl);
  } catch (error: any) {
    throw new Error(t("errors.failedToFetchImage"));
  }

  if (!response.ok) {
    throw new Error(t("errors.failedToFetchImage"));
  }

  const blob = await response.blob();

  if (blob.type && isSupportedImageFile(blob)) {
    const name = filename || blob.name || "";
    return new File([blob], name, { type: blob.type });
  }

  throw new Error(t("errors.unsupportedFileType"));
};

export const getFileFromEvent = async (
  event: React.DragEvent<HTMLDivElement>,
) => {
  const file = event.dataTransfer.files.item(0);
  const fileHandle = await getFileHandle(event);

  return { file: file ? await normalizeFile(file) : null, fileHandle };
};

export const getFileHandle = async (
  event: React.DragEvent<HTMLDivElement>,
): Promise<FileSystemHandle | null> => {
  if (nativeFileSystemSupported) {
    try {
      const item = event.dataTransfer.items[0];
      const handle: FileSystemHandle | null =
        (await (item as any).getAsFileSystemHandle()) || null;

      return handle;
    } catch (error: any) {
      console.warn(error.name, error.message);
      return null;
    }
  }
  return null;
};

/**
 * attempts to detect if a buffer is a valid image by checking its leading bytes
 */
const getActualMimeTypeFromImage = (buffer: ArrayBuffer) => {
  let mimeType: ValueOf<Pick<typeof MIME_TYPES, "png" | "jpg" | "gif">> | null =
    null;

  const first8Bytes = `${[...new Uint8Array(buffer).slice(0, 8)].join(" ")} `;

  // uint8 leading bytes
  const headerBytes = {
    // https://en.wikipedia.org/wiki/Portable_Network_Graphics#File_header
    png: "137 80 78 71 13 10 26 10 ",
    // https://en.wikipedia.org/wiki/JPEG#Syntax_and_structure
    // jpg is a bit wonky. Checking the first three bytes should be enough,
    // but may yield false positives. (https://stackoverflow.com/a/23360709/927631)
    jpg: "255 216 255 ",
    // https://en.wikipedia.org/wiki/GIF#Example_GIF_file
    gif: "71 73 70 56 57 97 ",
  };

  if (first8Bytes === headerBytes.png) {
    mimeType = MIME_TYPES.png;
  } else if (first8Bytes.startsWith(headerBytes.jpg)) {
    mimeType = MIME_TYPES.jpg;
  } else if (first8Bytes.startsWith(headerBytes.gif)) {
    mimeType = MIME_TYPES.gif;
  }
  return mimeType;
};

export const createFile = (
  blob: File | Blob | ArrayBuffer,
  mimeType: ValueOf<typeof MIME_TYPES>,
  name: string | undefined,
) => {
  return new File([blob], name || "", {
    type: mimeType,
  });
};

/** attempts to detect correct mimeType if none is set, or if an image
 * has an incorrect extension.
 * Note: doesn't handle missing .excalidraw/.excalidrawlib extension  */
export const normalizeFile = async (file: File) => {
  if (!file.type) {
    if (file?.name?.endsWith(".excalidrawlib")) {
      file = createFile(
        await blobToArrayBuffer(file),
        MIME_TYPES.excalidrawlib,
        file.name,
      );
    } else if (file?.name?.endsWith(".excalidraw")) {
      file = createFile(
        await blobToArrayBuffer(file),
        MIME_TYPES.excalidraw,
        file.name,
      );
    } else {
      const buffer = await blobToArrayBuffer(file);
      const mimeType = getActualMimeTypeFromImage(buffer);
      if (mimeType) {
        file = createFile(buffer, mimeType, file.name);
      }
    }
    // when the file is an image, make sure the extension corresponds to the
    // actual mimeType (this is an edge case, but happens sometime)
  } else if (isSupportedImageFile(file)) {
    const buffer = await blobToArrayBuffer(file);
    const mimeType = getActualMimeTypeFromImage(buffer);
    if (mimeType && mimeType !== file.type) {
      file = createFile(buffer, mimeType, file.name);
    }
  }

  return file;
};

export const blobToArrayBuffer = (blob: Blob): Promise<ArrayBuffer> => {
  if ("arrayBuffer" in blob) {
    return blob.arrayBuffer();
  }
  // Safari
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      if (!event.target?.result) {
        return reject(new Error("Couldn't convert blob to ArrayBuffer"));
      }
      resolve(event.target.result as ArrayBuffer);
    };
    reader.readAsArrayBuffer(blob);
  });
};

export function base64toBlob(
  base64Data: string,
  contentType: typeof MIME_TYPES[keyof typeof MIME_TYPES],
) {
  contentType = contentType || "";
  const sliceSize = 1024;
  const byteCharacters = window.atob(base64Data.split(",")[1]);
  const bytesLength = byteCharacters.length;
  const slicesCount = Math.ceil(bytesLength / sliceSize);
  const byteArrays = new Array(slicesCount);

  for (let sliceIndex = 0; sliceIndex < slicesCount; ++sliceIndex) {
    const begin = sliceIndex * sliceSize;
    const end = Math.min(begin + sliceSize, bytesLength);

    const bytes = new Array(end - begin);
    for (let offset = begin, i = 0; offset < end; ++i, ++offset) {
      bytes[i] = byteCharacters[offset].charCodeAt(0);
    }
    byteArrays[sliceIndex] = new Uint8Array(bytes);
  }
  return new Blob(byteArrays, { type: contentType });
}

export const toDataURL = (url: string): Promise<string | ArrayBuffer | null> =>
  fetch(url)
    .then((response) => response.blob())
    .then(
      (blob) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        }),
    );

export const base64ToFile = (base64: string, filename: string) => {
  const arr = base64.split(",");
  const mime = arr[0].match(/:(.*?);/)![1];
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);

  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }

  return new File([u8arr], filename, { type: mime });
};
