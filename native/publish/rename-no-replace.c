/*
 * Android 桥：renameat2(RENAME_NOREPLACE) 经 Node-API 暴露为异步
 * renameNoReplace(src, dst, cb)，cb 收 0 或正 errno（与同库 tryLock 同一约定）。
 *
 * 为什么在这里（2026-09-23 真机）：Android 7+ 的 SELinux 策略禁止 untrusted_app
 * 对 app 私有目录调用 link(2)（EACCES），dsh 的"硬链接独占发布"原子落盘全部失效
 * （发消息报 EACCES: permission denied, link '...tmp' -> '...'）。rename(2) 允许
 * 但会覆盖目标；renameat2 + RENAME_NOREPLACE 恢复 link 的完整语义：原子、
 * 冲突返回 EEXIST、绝不覆盖既有内容。EINVAL（文件系统不支持 NOREPLACE）原样回传，
 * 由 JS 垫片决定回退策略。
 *
 * 用 syscall(2) 包装而非 renameat2() 原型：bionic 的声明随 API level 漂移
 * （API 26+ 才有），SYS_renameat2 号自 kernel 3.15 稳定，绕开头文件差异。
 */

#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE 1
#endif

typedef struct {
  napi_env env;
  napi_ref callback;
  napi_async_work work;
  napi_async_cleanup_hook_handle cleanup;
  char *src;
  char *dst;
  int error;
  bool closing;
} rename_request;

static void check_status(napi_status status, const char *message) {
  if (status != napi_ok) {
    napi_fatal_error("rename_no_replace", NAPI_AUTO_LENGTH, message, NAPI_AUTO_LENGTH);
  }
}

static void release_request(rename_request *request) {
  if (request->callback != NULL) {
    (void)napi_delete_reference(request->env, request->callback);
  }
  if (request->work != NULL) {
    (void)napi_delete_async_work(request->env, request->work);
  }
  if (request->cleanup != NULL) {
    (void)napi_remove_async_cleanup_hook(request->cleanup);
  }
  free(request->src);
  free(request->dst);
  free(request);
}

static napi_value throw_setup_error(napi_env env, napi_status status,
                                    const char *message) {
  if (status != napi_pending_exception) {
    status = napi_throw_error(env, "ERR_RENAME_ASYNC_WORK", message);
    bool pending;
    check_status(napi_is_exception_pending(env, &pending), "Cannot inspect rename setup exception");
    if (!pending && status != napi_pending_exception) check_status(status, message);
  }
  return NULL;
}

static void execute_rename(napi_env env, void *data) {
  (void)env;
  rename_request *request = data;
  long rc = syscall(SYS_renameat2, AT_FDCWD, request->src, AT_FDCWD, request->dst,
                    (unsigned int)RENAME_NOREPLACE);
  request->error = rc == 0 ? 0 : errno;
}

static void complete_rename(napi_env env, napi_status status, void *data) {
  rename_request *request = data;
  if (env != NULL && !request->closing) {
    napi_value callback;
    napi_value receiver;
    napi_value result;
    check_status(status, "rename async work did not complete");
    check_status(napi_get_reference_value(env, request->callback, &callback),
                 "Cannot retrieve rename callback");
    check_status(napi_get_undefined(env, &receiver), "Cannot create rename receiver");
    check_status(napi_create_int32(env, request->error, &result),
                 "Cannot create rename result");
    status = napi_call_function(env, receiver, callback, 1, &result, NULL);
  } else {
    status = napi_ok;
  }
  release_request(request);
  if (status != napi_pending_exception) {
    check_status(status, "Cannot invoke rename callback");
  }
}

static void cleanup_rename(napi_async_cleanup_hook_handle handle, void *data) {
  (void)handle;
  rename_request *request = data;
  request->closing = true;
  (void)napi_cancel_async_work(request->env, request->work);
}

/* 读取一个必填字符串参数并 strdup（工作线程持有，完成后 free）。 */
static char *read_string(napi_env env, napi_value value) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &len) != napi_ok) return NULL;
  char *buf = malloc(len + 1);
  if (buf == NULL) {
    (void)napi_throw_error(env, "ENOMEM", "Cannot allocate rename argument");
    return NULL;
  }
  if (napi_get_value_string_utf8(env, value, buf, len + 1, &len) != napi_ok) {
    free(buf);
    return NULL;
  }
  return buf;
}

static napi_value rename_no_replace(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_status status = napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (status != napi_ok) {
    return throw_setup_error(env, status, "Cannot read rename arguments");
  }
  napi_valuetype t0, t1, t2;
  if (argc < 3 || napi_typeof(env, argv[0], &t0) != napi_ok || t0 != napi_string ||
      napi_typeof(env, argv[1], &t1) != napi_ok || t1 != napi_string ||
      napi_typeof(env, argv[2], &t2) != napi_ok || t2 != napi_function) {
    (void)napi_throw_type_error(env, NULL, "renameNoReplace(src, dst, callback): strings + function required");
    return NULL;
  }
  rename_request *request = calloc(1, sizeof(*request));
  if (request == NULL) {
    (void)napi_throw_error(env, "ENOMEM", "Cannot allocate rename async work");
    return NULL;
  }
  request->env = env;
  request->src = read_string(env, argv[0]);
  request->dst = read_string(env, argv[1]);
  if (request->src == NULL || request->dst == NULL) {
    bool pending = false;
    (void)napi_is_exception_pending(env, &pending);
    release_request(request);
    if (pending) return NULL; /* ENOMEM 路径已抛 JS 异常，直接冒泡 */
    return throw_setup_error(env, napi_generic_failure, "Cannot read rename path argument");
  }
  status = napi_create_reference(env, argv[2], 1, &request->callback);
  if (status != napi_ok) {
    release_request(request);
    return throw_setup_error(env, status, "Cannot retain rename callback");
  }
  napi_value name;
  status = napi_create_string_utf8(env, "rename_no_replace", NAPI_AUTO_LENGTH, &name);
  if (status == napi_ok) {
    status = napi_create_async_work(env, NULL, name, execute_rename, complete_rename,
                                    request, &request->work);
  }
  if (status != napi_ok) {
    release_request(request);
    return throw_setup_error(env, status, "Cannot create rename async work");
  }
  status = napi_add_async_cleanup_hook(env, cleanup_rename, request, &request->cleanup);
  if (status != napi_ok) {
    release_request(request);
    return throw_setup_error(env, status, "Cannot register rename environment cleanup");
  }
  status = napi_queue_async_work(env, request->work);
  if (status != napi_ok) {
    release_request(request);
    return throw_setup_error(env, status, "Cannot queue rename async work");
  }
  return NULL;
}

NAPI_MODULE_INIT() {
  napi_value function;
  if (napi_create_function(env, "renameNoReplace", NAPI_AUTO_LENGTH, rename_no_replace,
                           NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "renameNoReplace", function) != napi_ok) {
    return NULL;
  }
  return exports;
}
