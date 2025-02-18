// Copyright 2020 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {firestore, google} from '../protos/firestore_v1_proto_api';

import {DocumentSnapshot} from './document';
import {QuerySnapshot} from './reference';
import {Timestamp} from './timestamp';
import {
  invalidArgumentMessage,
  validateMaxNumberOfArguments,
  validateMinNumberOfArguments,
  validateString,
} from './validate';

import api = google.firestore.v1;

const BUNDLE_VERSION = 1;

/**
 * Builds a Firestore data bundle with results from the given document and query snapshots.
 */
export class BundleBuilder {
  // Resulting documents for the bundle, keyed by full document path.
  private documents: Map<string, BundledDocument> = new Map();
  // Named queries saved in the bundle, keyed by query name.
  private namedQueries: Map<string, firestore.INamedQuery> = new Map();

  // The latest read time among all bundled documents and queries.
  private latestReadTime = new Timestamp(0, 0);

  constructor(readonly bundleId: string) {}

  add(documentSnapshot: DocumentSnapshot): BundleBuilder;
  add(queryName: string, querySnapshot: QuerySnapshot): BundleBuilder;
  /**
   * Adds a Firestore document snapshot or query snapshot to the bundle.
   * Both the documents data and the query read time will be included in the bundle.
   *
   * @param {DocumentSnapshot | string} documentOrName A document snapshot to add or a name of a query.
   * @param {Query=} querySnapshot A query snapshot to add to the bundle, if provided.
   * @returns {BundleBuilder} This instance.
   *
   * @example
   * const bundle = firestore.bundle('data-bundle');
   * const docSnapshot = await firestore.doc('abc/123').get();
   * const querySnapshot = await firestore.collection('coll').get();
   *
   * const bundleBuffer = bundle.add(docSnapshot); // Add a document
   *                            .add('coll-query', querySnapshot) // Add a named query.
   *                            .build()
   * // Save `bundleBuffer` to CDN or stream it to clients.
   */
  add(
    documentOrName: DocumentSnapshot | string,
    querySnapshot?: QuerySnapshot
  ): BundleBuilder {
    // eslint-disable-next-line prefer-rest-params
    validateMinNumberOfArguments('BundleBuilder.add', arguments, 1);
    // eslint-disable-next-line prefer-rest-params
    validateMaxNumberOfArguments('BundleBuilder.add', arguments, 2);
    if (arguments.length === 1) {
      validateDocumentSnapshot('documentOrName', documentOrName);
      this.addBundledDocument(documentOrName as DocumentSnapshot);
    } else {
      validateString('documentOrName', documentOrName);
      validateQuerySnapshot('querySnapshot', querySnapshot);
      this.addNamedQuery(documentOrName as string, querySnapshot!);
    }

    return this;
  }

  private addBundledDocument(snap: DocumentSnapshot, queryName?: string): void {
    const originalDocument = this.documents.get(snap.ref.path);
    const originalQueries = originalDocument?.metadata.queries;

    // Update with document built from `snap` because it is newer.
    if (
      !originalDocument ||
      Timestamp.fromProto(originalDocument.metadata.readTime!) < snap.readTime
    ) {
      const docProto = snap.toDocumentProto();
      this.documents.set(snap.ref.path, {
        document: snap.exists ? docProto : undefined,
        metadata: {
          name: docProto.name,
          readTime: snap.readTime.toProto().timestampValue,
          exists: snap.exists,
        },
      });
    }

    // Update `queries` to include both original and `queryName`.
    const newDocument = this.documents.get(snap.ref.path)!;
    newDocument.metadata.queries = originalQueries || [];
    if (queryName) {
      newDocument.metadata.queries!.push(queryName);
    }

    if (snap.readTime > this.latestReadTime) {
      this.latestReadTime = snap.readTime;
    }
  }

  private addNamedQuery(name: string, querySnap: QuerySnapshot): void {
    if (this.namedQueries.has(name)) {
      throw new Error(`Query name conflict: ${name} has already been added.`);
    }

    this.namedQueries.set(name, {
      name,
      bundledQuery: querySnap.query._toBundledQuery(),
      readTime: querySnap.readTime.toProto().timestampValue,
    });

    for (const snap of querySnap.docs) {
      this.addBundledDocument(snap, name);
    }

    if (querySnap.readTime > this.latestReadTime) {
      this.latestReadTime = querySnap.readTime;
    }
  }

  /**
   * Converts a IBundleElement to a Buffer whose content is the length prefixed JSON representation
   * of the element.
   * @private
   * @internal
   */
  private elementToLengthPrefixedBuffer(
    bundleElement: firestore.IBundleElement
  ): Buffer {
    // Convert to a valid proto message object then take its JSON representation.
    // This take cares of stuff like converting internal byte array fields
    // to Base64 encodings.
    // We lazy-load the Proto file to reduce cold-start times.
    const message = require('../protos/firestore_v1_proto_api')
      .firestore.BundleElement.fromObject(bundleElement)
      .toJSON();
    const buffer = Buffer.from(JSON.stringify(message), 'utf-8');
    const lengthBuffer = Buffer.from(buffer.length.toString());
    return Buffer.concat([lengthBuffer, buffer]);
  }

  build(): Buffer {
    let bundleBuffer = Buffer.alloc(0);

    for (const namedQuery of this.namedQueries.values()) {
      bundleBuffer = Buffer.concat([
        bundleBuffer,
        this.elementToLengthPrefixedBuffer({namedQuery}),
      ]);
    }

    for (const bundledDocument of this.documents.values()) {
      const documentMetadata: firestore.IBundledDocumentMetadata =
        bundledDocument.metadata;

      bundleBuffer = Buffer.concat([
        bundleBuffer,
        this.elementToLengthPrefixedBuffer({documentMetadata}),
      ]);
      // Write to the bundle if document exists.
      const document = bundledDocument.document;
      if (document) {
        bundleBuffer = Buffer.concat([
          bundleBuffer,
          this.elementToLengthPrefixedBuffer({document}),
        ]);
      }
    }

    const metadata: firestore.IBundleMetadata = {
      id: this.bundleId,
      createTime: this.latestReadTime.toProto().timestampValue,
      version: BUNDLE_VERSION,
      totalDocuments: this.documents.size,
      totalBytes: bundleBuffer.length,
    };
    // Prepends the metadata element to the bundleBuffer: `bundleBuffer` is the second argument to `Buffer.concat`.
    bundleBuffer = Buffer.concat([
      this.elementToLengthPrefixedBuffer({metadata}),
      bundleBuffer,
    ]);
    return bundleBuffer;
  }
}

/**
 * Convenient class to hold both the metadata and the actual content of a document to be bundled.
 * @private
 * @internal
 */
class BundledDocument {
  constructor(
    readonly metadata: firestore.IBundledDocumentMetadata,
    readonly document?: api.IDocument
  ) {}
}

/**
 * Validates that 'value' is DocumentSnapshot.
 *
 * @private
 * @internal
 * @param arg The argument name or argument index (for varargs methods).
 * @param value The input to validate.
 */
function validateDocumentSnapshot(arg: string | number, value: unknown): void {
  if (!(value instanceof DocumentSnapshot)) {
    throw new Error(invalidArgumentMessage(arg, 'DocumentSnapshot'));
  }
}

/**
 * Validates that 'value' is QuerySnapshot.
 *
 * @private
 * @internal
 * @param arg The argument name or argument index (for varargs methods).
 * @param value The input to validate.
 */
function validateQuerySnapshot(arg: string | number, value: unknown): void {
  if (!(value instanceof QuerySnapshot)) {
    throw new Error(invalidArgumentMessage(arg, 'QuerySnapshot'));
  }
}
