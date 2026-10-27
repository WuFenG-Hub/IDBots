export interface MockArtifact {
  path: string;
  mime: string;
  bytes: () => Uint8Array;
}

export const MOCK_ARTIFACT_PATHS = {
  image: '/data/workspace/artifacts/chart.png',
  pdf: '/data/workspace/artifacts/report.pdf',
  markdown: '/data/workspace/artifacts/notes.md',
  refresh: '/data/workspace/artifacts/refresh.md',
  text: '/data/workspace/artifacts/result.txt',
} as const;

const textBytes = (text: string): Uint8Array => new TextEncoder().encode(text);

export function createMockArtifactPdf(): Uint8Array {
  const stream = 'BT /F1 14 Tf 24 76 Td (Mobile artifact preview) Tj ET\n';
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 140] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(pdf.length);
    pdf += object;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return textBytes(pdf);
}

const MOCK_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export function createMockArtifactImage(): Uint8Array {
  return Uint8Array.from(atob(MOCK_PNG_BASE64), (character) => character.charCodeAt(0));
}

const artifacts: MockArtifact[] = [
  { path: MOCK_ARTIFACT_PATHS.image, mime: 'image/png', bytes: createMockArtifactImage },
  { path: MOCK_ARTIFACT_PATHS.pdf, mime: 'application/pdf', bytes: createMockArtifactPdf },
  {
    path: MOCK_ARTIFACT_PATHS.markdown,
    mime: 'text/markdown',
    bytes: () => textBytes('# Mobile artifact\n\nThis **Markdown** came from the signed file.\n\n- Preview stays in chat.\n- Download remains available.\n'),
  },
  {
    path: MOCK_ARTIFACT_PATHS.refresh,
    mime: 'text/markdown',
    bytes: () => textBytes('# Refresh fixture\n\nThe preview remains open when this URL rotates.\n'),
  },
  { path: MOCK_ARTIFACT_PATHS.text, mime: 'text/plain', bytes: () => textBytes('Artifact download fixture\n') },
];

export function getMockArtifact(path: string): MockArtifact | undefined {
  return artifacts.find((artifact) => artifact.path === path);
}

export function mockArtifactFilename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || 'file';
}
