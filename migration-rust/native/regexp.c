/* MIT. Standalone ECMAScript regexp bridge; no JavaScript VM is linked. */
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include "cutils.h"
#include "libregexp.h"

#define DEF(name, size) OP_##name,
enum {
#include "libregexp-opcode.h"
};
#undef DEF

/* Each synchronous entry records its own stack origin, including worker threads. */
typedef struct { uintptr_t stack_origin; } RegexCall;
bool lre_check_stack_overflow(void *opaque, size_t extra) {
    char here;
    uintptr_t origin = ((RegexCall *)opaque)->stack_origin;
    uintptr_t position = (uintptr_t)&here;
    size_t distance = origin > position ? origin - position : position - origin;
    return extra > 256 * 1024 || distance > 256 * 1024 - extra;
}
int lre_check_timeout(void *opaque) { (void)opaque; return 0; }
void *lre_realloc(void *opaque, void *ptr, size_t size) {
    (void)opaque;
    if (!size) { free(ptr); return NULL; }
    return realloc(ptr, size);
}
uint8_t *prts_re_compile(const char *pattern, size_t length, int flags,
                        int *length_out, char *error, int error_length) {
    RegexCall call = { (uintptr_t)&call };
    return lre_compile(length_out, error, error_length, pattern, length, flags, &call);
}
void prts_re_free(void *ptr) { free(ptr); }
int prts_re_exec(const uint8_t *bytecode, const uint16_t *text, int length,
                 int start, int *match_start, int *match_end) {
    uint8_t *captures[510] = {0}; /* max 255 captures, including the full match */
    RegexCall call = { (uintptr_t)&call };
    int result = lre_exec(captures, bytecode, (const uint8_t *)text,
                          start, length, 1, &call);
    if (result == 1) {
        *match_start = (int)((captures[0] - (const uint8_t *)text) / 2);
        *match_end = (int)((captures[1] - (const uint8_t *)text) / 2);
    }
    return result;
}

/* A mandatory prefix is proven from the compiler's linear bytecode, never
   guessed from pattern spelling. Stop before any branch/assertion/quantifier.
   Only this pinned upstream bytecode format is accepted here. */
int prts_re_prefix(const uint8_t *bc, int length, uint32_t *prefix, int capacity,
                   int *insensitive, int *complete) {
    int p = 8, n = 0, mode = -1;
    *complete = 0;
    if (length < 21 || bc[p] != OP_split_goto_first || get_u32(bc+p+1) != 6 ||
        bc[p+5] != OP_any || bc[p+6] != OP_goto ||
        (int32_t)get_u32(bc+p+7) != -11) return 0;
    p += 11;
    if (bc[p] != OP_save_start || bc[p+1] != 0) return 0;
    p += 2;
    while (p < length) {
        int op = bc[p];
        if (op == OP_save_start || op == OP_save_end) {
            if (p+2 > length) break;
            p += 2;
            continue;
        }
        if (op == OP_match) { *complete = 1; break; }
        int is_i = op == OP_char_i || op == OP_char32_i;
        int size = op == OP_char || op == OP_char_i ? 3 :
                   op == OP_char32 || op == OP_char32_i ? 5 : 0;
        if (!size || p+size > length || n == capacity ||
            (mode != -1 && mode != is_i)) break;
        mode = is_i;
        prefix[n++] = size == 3 ? get_u16(bc+p+1) : get_u32(bc+p+1);
        p += size;
    }
    *insensitive = mode == 1;
    return n;
}
int prts_re_fold(uint32_t codepoint) { return lre_canonicalize(codepoint, true); }
