import { partitionReplayReceiptCopies } from '../../src/scripts/phase2/replay-receipt.util';

describe('partitionReplayReceiptCopies', () => {
    it('retains only the number of exact receipts supported by the source', () => {
        const rows = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
        expect(partitionReplayReceiptCopies(rows, 2)).toEqual({
            retained: [{ id: 1 }, { id: 2 }],
            excess: [{ id: 3 }, { id: 4 }],
        });
    });

    it('retains source-supported same-day multiplicity without treating it as duplication', () => {
        const rows = [{ id: 1 }, { id: 2 }];
        expect(partitionReplayReceiptCopies(rows, 2)).toEqual({ retained: rows, excess: [] });
    });

    it('never keeps target rows when the caller proves the source count is zero', () => {
        expect(partitionReplayReceiptCopies([{ id: 1 }], 0)).toEqual({ retained: [], excess: [{ id: 1 }] });
    });
});
