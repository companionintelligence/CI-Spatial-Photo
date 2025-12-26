import { PlyReader } from "@sparkjsdev/spark";
import { buildCameraMetadata } from "./cameraMetadata.js";

// Fallback if PlyReader is not available
const MockPlyReader = class {
    constructor(buffer) {
        this.buffer = buffer;
        this.header = this.parseHeader();
    }
    
    parseHeader() {
        const textDecoder = new TextDecoder();
        const headerText = textDecoder.decode(this.buffer.slice(0, 10000)); // Read first 10KB
        const headerEnd = headerText.indexOf('end_header');
        if (headerEnd === -1) throw new Error('Invalid PLY header');
        
        const lines = headerText.slice(0, headerEnd).split('\n');
        const elements = [];
        let currentElement = null;
        
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts[0] === 'element') {
                currentElement = { name: parts[1], count: parseInt(parts[2]), properties: [] };
                elements.push(currentElement);
            } else if (parts[0] === 'property') {
                if (currentElement) {
                    if (parts[1] === 'list') {
                         currentElement.properties.push({ name: parts[4], type: parts[3], isList: true, countType: parts[2] });
                    } else {
                         currentElement.properties.push({ name: parts[2], type: parts[1], isList: false });
                    }
                }
            }
        }
        return { elements, headerLength: headerEnd + 11 }; // +11 for "end_header\n"
    }
    
    readElementData(elementName) {
        // This is a very basic reader, might not support all PLY features (like binary/ascii distinction properly)
        // Assuming binary little endian for now as that's what ml-sharp produces
        
        const element = this.header.elements.find(e => e.name === elementName);
        if (!element) return null;
        
        // We need to skip previous elements
        let offset = this.header.headerLength;
        const dataView = new DataView(this.buffer);
        
        for (const el of this.header.elements) {
            if (el.name === elementName) {
                // Read this element
                const items = [];
                for (let i = 0; i < el.count; i++) {
                    const item = {};
                    for (const prop of el.properties) {
                        if (prop.isList) {
                            // Read list count
                            const count = readScalar(dataView, offset, prop.countType, true);
                            offset += FIELD_BYTES[prop.countType];
                            const list = [];
                            for (let j = 0; j < count; j++) {
                                list.push(readScalar(dataView, offset, prop.type, true));
                                offset += FIELD_BYTES[prop.type];
                            }
                            item[prop.name] = list;
                        } else {
                            item[prop.name] = readScalar(dataView, offset, prop.type, true);
                            offset += FIELD_BYTES[prop.type];
                        }
                    }
                    items.push(item);
                }
                return items;
            } else {
                // Skip this element
                for (let i = 0; i < el.count; i++) {
                    for (const prop of el.properties) {
                        if (prop.isList) {
                             const count = readScalar(dataView, offset, prop.countType, true);
                             offset += FIELD_BYTES[prop.countType];
                             offset += count * FIELD_BYTES[prop.type];
                        } else {
                             offset += FIELD_BYTES[prop.type];
                        }
                    }
                }
            }
        }
        return null;
    }
};

const Reader = PlyReader || MockPlyReader;

const FIELD_BYTES = {
  char: 1,
  uchar: 1,
  short: 2,
  ushort: 2,
  int: 4,
  uint: 4,
  float: 4,
  double: 8,
};

const readScalar = (dataView, offset, type, littleEndian) => {
  switch (type) {
    case "char":
      return dataView.getInt8(offset);
    case "uchar":
      return dataView.getUint8(offset);
    case "short":
      return dataView.getInt16(offset, littleEndian);
    case "ushort":
      return dataView.getUint16(offset, littleEndian);
    case "int":
      return dataView.getInt32(offset, littleEndian);
    case "uint":
      return dataView.getUint32(offset, littleEndian);
    case "float":
      return dataView.getFloat32(offset, littleEndian);
    case "double":
      return dataView.getFloat64(offset, littleEndian);
    default:
      throw new Error(`Unsupported PLY field type: ${type}`);
  }
};

const computeStrideForItem = (properties, dataView, itemOffset, littleEndian) => {
  let offset = itemOffset;
  const listLengths = {};

  for (const [propertyName, property] of properties) {
    if (!property.isList) {
      const bytes = FIELD_BYTES[property.type];
      if (bytes == null) {
        throw new Error(`Unsupported PLY field type: ${property.type}`);
      }
      offset += bytes;
      continue;
    }

    const countType = property.countType;
    const countTypeBytes = FIELD_BYTES[countType];
    const valueBytes = FIELD_BYTES[property.type];
    if (countTypeBytes == null || valueBytes == null) {
      throw new Error(`Unsupported PLY list field types: ${countType}, ${property.type}`);
    }

    const length = readScalar(dataView, offset, countType, littleEndian);
    offset += countTypeBytes;
    listLengths[propertyName] = length;
    offset += length * valueBytes;
  }

  return { stride: offset - itemOffset, listLengths };
};

const computeElementStrideInfo = (element, dataView, elementOffset, littleEndian) => {
  const properties = Object.entries(element.properties);
  const hasLists = properties.some(([, prop]) => prop.isList);

  if (!hasLists) {
    const stride = properties.reduce((sum, [, prop]) => sum + FIELD_BYTES[prop.type], 0);
    return { stride, constant: true };
  }

  if (element.count <= 0) {
    return { stride: 0, constant: true };
  }

  const first = computeStrideForItem(properties, dataView, elementOffset, littleEndian);
  if (element.count === 1) {
    return { stride: first.stride, constant: true };
  }

  const secondOffset = elementOffset + first.stride;
  const second = computeStrideForItem(properties, dataView, secondOffset, littleEndian);

  if (second.stride !== first.stride) {
    return { stride: first.stride, constant: false };
  }

  for (const [key, value] of Object.entries(first.listLengths)) {
    if (second.listLengths[key] !== value) {
      return { stride: first.stride, constant: false };
    }
  }

  return { stride: first.stride, constant: true };
};

const skipElement = (element, dataView, elementOffset, littleEndian) => {
  if (element.count <= 0) return elementOffset;

  const properties = Object.entries(element.properties);
  const hasLists = properties.some(([, prop]) => prop.isList);

  if (!hasLists) {
    const stride = properties.reduce((sum, [, prop]) => sum + FIELD_BYTES[prop.type], 0);
    return elementOffset + element.count * stride;
  }

  const strideInfo = computeElementStrideInfo(
    element,
    dataView,
    elementOffset,
    littleEndian,
  );
  if (strideInfo.constant) {
    return elementOffset + element.count * strideInfo.stride;
  }

  let offset = elementOffset;
  for (let index = 0; index < element.count; index += 1) {
    offset += computeStrideForItem(properties, dataView, offset, littleEndian).stride;
  }
  return offset;
};

const readSinglePropertyElement = (element, dataView, elementOffset, littleEndian) => {
  const properties = Object.entries(element.properties);
  if (properties.length !== 1) return null;

  const [propertyName, property] = properties[0];
  if (property.isList) return null;

  const stride = FIELD_BYTES[property.type];
  if (stride == null) {
    throw new Error(`Unsupported PLY field type: ${property.type}`);
  }

  const values = new Array(element.count);
  let offset = elementOffset;
  for (let i = 0; i < element.count; i += 1) {
    values[i] = readScalar(dataView, offset, property.type, littleEndian);
    offset += stride;
  }

  return { propertyName, values, nextOffset: offset };
};

export const readPlyCamera = async (fileBytes) => {
  const buffer = fileBytes instanceof Uint8Array ? fileBytes.buffer : fileBytes;
  const reader = new MockPlyReader(buffer);
  
  const readFlat = (name) => {
      const items = reader.readElementData(name);
      if (!items) return undefined;
      const result = [];
      for (const item of items) {
          const values = Object.values(item);
          if (values.length > 0) {
              result.push(values[0]);
          }
      }
      return result;
  };

  const raw = {};
  raw.intrinsic = readFlat("intrinsic");
  raw.extrinsic = readFlat("extrinsic");
  raw.image_size = readFlat("image_size");
  raw.color_space = readFlat("color_space");

  return buildCameraMetadata({
    ...raw,
    headerComments: [],
  });
};
