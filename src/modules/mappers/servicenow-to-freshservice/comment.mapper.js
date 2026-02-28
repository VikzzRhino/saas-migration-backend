export function mapNote(snow) {
  return {
    body: snow.value || '-',
    private: false,
  };
}
