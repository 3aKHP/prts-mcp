/* Native OS measurements; compiled into the product, no external runtime. */
#include <stdint.h>

#if defined(_WIN32)
#define PSAPI_VERSION 2
#include <windows.h>
#include <psapi.h>

int prts_process_memory(uint64_t *resident, uint64_t *peak) {
    PROCESS_MEMORY_COUNTERS info = {0};
    info.cb = sizeof(info);
    if (!GetProcessMemoryInfo(GetCurrentProcess(), &info, sizeof(info)))
        return 0;
    *resident = (uint64_t)info.WorkingSetSize;
    *peak = (uint64_t)info.PeakWorkingSetSize;
    return 1;
}
#elif defined(__APPLE__)
#include <mach/mach.h>

int prts_process_memory(uint64_t *resident, uint64_t *peak) {
    mach_task_basic_info_data_t info;
    mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
    if (task_info(mach_task_self(), MACH_TASK_BASIC_INFO,
                  (task_info_t)&info, &count) != KERN_SUCCESS)
        return 0;
    *resident = (uint64_t)info.resident_size;
    *peak = (uint64_t)info.resident_size_max;
    return 1;
}
#else
#include <unistd.h>
uint64_t prts_page_size(void) {
    long size = sysconf(_SC_PAGESIZE);
    return size > 0 ? (uint64_t)size : 0;
}
#endif
