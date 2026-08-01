/*
 * hud_web.c -- non-blocking loopback transport for the HUD web editor.
 *
 * This deliberately contains no HUD placement logic.  The engine-owned payload
 * functions in hud_web_state.c provide state and framebuffer data; this file
 * only authenticates and transports it.
 */

#include "quakedef.h"
#include "hud_web.h"

#include <jansson.h>
#include <limits.h>

#ifdef _WIN32
#include <windows.h>
#endif

#define HUD_WEB_MAX_CLIENTS          4
#define HUD_WEB_MAX_REQUEST          (64 * 1024)
#define HUD_WEB_MAX_TARGET           2048
#define HUD_WEB_CLIENT_TIMEOUT       2.0
/* The idle timer is reset by every byte received, so four connections trickling one
 * byte every 1.5s held all four slots forever and the real editor got refused. A
 * request also has to finish, not just keep talking. */
#define HUD_WEB_REQUEST_MAX_AGE      5.0
#define HUD_WEB_ACCEPTS_PER_FRAME    8
#define HUD_WEB_SEND_CHUNK           (64 * 1024)

#ifdef _WIN32
#define HUD_WEB_SEND_FLAGS 0
#else
#ifdef MSG_NOSIGNAL
#define HUD_WEB_SEND_FLAGS MSG_NOSIGNAL
#else
#define HUD_WEB_SEND_FLAGS 0
#endif
#endif

typedef struct hud_web_client_s {
	socket_t socket;
	byte request[HUD_WEB_MAX_REQUEST + 1];
	size_t request_length;
	double io_time;      /* last byte moved: idle timeout  */
	double accept_time;  /* connection accepted: age cap   */

	char response_header[768];
	size_t response_header_length;
	size_t response_header_sent;
	byte *response_body;
	size_t response_body_length;
	size_t response_body_sent;
	qbool responding;
} hud_web_client_t;

typedef struct hud_web_request_s {
	char method[16];
	char target[HUD_WEB_MAX_TARGET];
	const byte *body;
	size_t body_length;
	const char *header_token;
	size_t header_token_length;
} hud_web_request_t;

typedef enum hud_web_parse_result_e {
	HUD_WEB_PARSE_INCOMPLETE,
	HUD_WEB_PARSE_COMPLETE,
	HUD_WEB_PARSE_BAD,
	HUD_WEB_PARSE_TOO_LARGE
} hud_web_parse_result_t;

static cvar_t hud_web = { "hud_web", "0" };
static cvar_t hud_web_port = { "hud_web_port", "27700" };
/* A capture is a synchronous glReadPixels plus a PNG encode on the render thread:
 * milliseconds on a GPU, seconds on software GL. Nothing bounded how often clients
 * could ask, and four of them polling together cost four full captures in one
 * frame. Serve at most one per interval and let the rest wait. */
static cvar_t hud_web_frame_interval = { "hud_web_frame_interval", "250" };

static socket_t hud_web_listener = INVALID_SOCKET;
static hud_web_client_t hud_web_clients[HUD_WEB_MAX_CLIENTS];
static char hud_web_token[HUD_WEB_TOKEN_CHARS + 1];
static int hud_web_bound_port;
static int hud_web_retry_port;
static double hud_web_retry_after;
static qbool hud_web_initialized;

static qbool HUD_Web_IsWouldBlock(int error)
{
	return error == EWOULDBLOCK
#ifndef _WIN32
		|| error == EAGAIN
#endif
	;
}

static qbool HUD_Web_SetNonBlocking(socket_t socket)
{
	unsigned long enabled = 1;
	return ioctlsocket(socket, FIONBIO, &enabled) != SOCKET_ERROR;
}

static void HUD_Web_CloseClient(hud_web_client_t *client)
{
	if (client->socket != INVALID_SOCKET) {
		closesocket(client->socket);
	}
	if (client->response_body) {
		Q_free(client->response_body);
	}
	memset(client, 0, sizeof(*client));
	client->socket = INVALID_SOCKET;
}

static void HUD_Web_InvalidateToken(void)
{
	memset(hud_web_token, 0, sizeof(hud_web_token));
}

static void HUD_Web_Stop(qbool announce)
{
	int i;
	qbool was_running = hud_web_listener != INVALID_SOCKET;

	if (hud_web_listener != INVALID_SOCKET) {
		closesocket(hud_web_listener);
		hud_web_listener = INVALID_SOCKET;
	}
	for (i = 0; i < HUD_WEB_MAX_CLIENTS; ++i) {
		HUD_Web_CloseClient(&hud_web_clients[i]);
	}
	HUD_Web_InvalidateToken();
	hud_web_bound_port = 0;

	if (announce && was_running) {
		Com_Printf("HUD bridge disabled\n");
	}
}

static qbool HUD_Web_RandomBytes(byte *output, size_t length)
{
#ifdef _WIN32
	/* Resolve BCryptGenRandom dynamically so this file needs no new linker input. */
	typedef LONG (WINAPI *bcrypt_gen_random_fn)(void *, unsigned char *, unsigned long, unsigned long);
	HMODULE library = LoadLibraryA("bcrypt.dll");
	bcrypt_gen_random_fn generate;
	LONG result;

	if (!library || length > ULONG_MAX) {
		if (library) {
			FreeLibrary(library);
		}
		return false;
	}
	generate = (bcrypt_gen_random_fn)(void *)GetProcAddress(library, "BCryptGenRandom");
	if (!generate) {
		FreeLibrary(library);
		return false;
	}
	/* BCRYPT_USE_SYSTEM_PREFERRED_RNG */
	result = generate(NULL, output, (unsigned long)length, 0x00000002UL);
	FreeLibrary(library);
	return result >= 0;
#else
	int descriptor;
	size_t offset = 0;

	descriptor = open("/dev/urandom", O_RDONLY | O_NONBLOCK);
	if (descriptor < 0) {
		return false;
	}
	while (offset < length) {
		ssize_t count = read(descriptor, output + offset, length - offset);
		if (count > 0) {
			offset += (size_t)count;
			continue;
		}
		if (count < 0 && errno == EINTR) {
			continue;
		}
		close(descriptor);
		return false;
	}
	close(descriptor);
	return true;
#endif
}

static qbool HUD_Web_MintToken(void)
{
	static const char hex[] = "0123456789abcdef";
	byte random[HUD_WEB_TOKEN_CHARS / 2];
	int i;

	if (!HUD_Web_RandomBytes(random, sizeof(random))) {
		return false;
	}
	for (i = 0; i < (int)sizeof(random); ++i) {
		hud_web_token[i * 2] = hex[random[i] >> 4];
		hud_web_token[i * 2 + 1] = hex[random[i] & 15];
	}
	hud_web_token[HUD_WEB_TOKEN_CHARS] = '\0';
	return true;
}

static qbool HUD_Web_Start(int port)
{
	struct sockaddr_in address;
	socket_t listener;

	listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
	if (listener == INVALID_SOCKET) {
		Com_Printf("HUD bridge: socket failed (%d)\n", qerrno);
		return false;
	}

	if (!HUD_Web_SetNonBlocking(listener)) {
		Com_Printf("HUD bridge: failed to make listener non-blocking (%d)\n", qerrno);
		closesocket(listener);
		return false;
	}

#ifdef _WIN32
	{
		BOOL exclusive = TRUE;
		if (setsockopt(listener, SOL_SOCKET, SO_EXCLUSIVEADDRUSE,
				(const char *)&exclusive, sizeof(exclusive)) == SOCKET_ERROR) {
			Com_Printf("HUD bridge: failed to reserve loopback port (%d)\n", qerrno);
			closesocket(listener);
			return false;
		}
	}
#else
	{
		int reuse = 1;
		if (setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse)) == SOCKET_ERROR) {
			Com_Printf("HUD bridge: failed to configure loopback port (%d)\n", qerrno);
			closesocket(listener);
			return false;
		}
	}
#endif

	memset(&address, 0, sizeof(address));
	address.sin_family = AF_INET;
	address.sin_port = htons((unsigned short)port);
	/* Explicit loopback binding is a security invariant.  Never use INADDR_ANY. */
	address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

	if (bind(listener, (struct sockaddr *)&address, sizeof(address)) == SOCKET_ERROR) {
		Com_Printf("HUD bridge: could not bind 127.0.0.1:%d (%d)\n", port, qerrno);
		closesocket(listener);
		return false;
	}
	if (listen(listener, HUD_WEB_MAX_CLIENTS) == SOCKET_ERROR) {
		Com_Printf("HUD bridge: listen failed on 127.0.0.1:%d (%d)\n", port, qerrno);
		closesocket(listener);
		return false;
	}
	if (!HUD_Web_MintToken()) {
		Com_Printf("HUD bridge: secure token generation failed\n");
		closesocket(listener);
		return false;
	}

	hud_web_listener = listener;
	hud_web_bound_port = port;
	Com_Printf("HUD bridge: editor at http://127.0.0.1:%d/?t=%s\n", port, hud_web_token);
	return true;
}

static int HUD_Web_ASCIIToLower(int c)
{
	return c >= 'A' && c <= 'Z' ? c + ('a' - 'A') : c;
}

static qbool HUD_Web_SpanEqualsInsensitive(const char *value, size_t value_length, const char *expected)
{
	size_t i;
	size_t expected_length = strlen(expected);

	if (value_length != expected_length) {
		return false;
	}
	for (i = 0; i < value_length; ++i) {
		if (HUD_Web_ASCIIToLower((unsigned char)value[i]) != HUD_Web_ASCIIToLower((unsigned char)expected[i])) {
			return false;
		}
	}
	return true;
}

static qbool HUD_Web_TokenEquals(const char *candidate, size_t candidate_length)
{
	size_t i;
	unsigned int difference;

	if (!candidate || candidate_length != HUD_WEB_TOKEN_CHARS || !hud_web_token[0]) {
		return false;
	}
	difference = 0;
	for (i = 0; i < HUD_WEB_TOKEN_CHARS; ++i) {
		difference |= (unsigned char)candidate[i] ^ (unsigned char)hud_web_token[i];
	}
	return difference == 0;
}

static const byte *HUD_Web_FindBytes(const byte *buffer, size_t length, const char *needle, size_t needle_length)
{
	size_t i;

	if (needle_length > length) {
		return NULL;
	}
	for (i = 0; i + needle_length <= length; ++i) {
		if (!memcmp(buffer + i, needle, needle_length)) {
			return buffer + i;
		}
	}
	return NULL;
}

static qbool HUD_Web_ParseContentLength(const char *value, size_t length, size_t *result)
{
	size_t parsed = 0;
	size_t i;

	if (!length) {
		return false;
	}
	for (i = 0; i < length; ++i) {
		unsigned int digit;
		if (value[i] < '0' || value[i] > '9') {
			return false;
		}
		digit = (unsigned int)(value[i] - '0');
		if (parsed > (SIZE_MAX - digit) / 10) {
			return false;
		}
		parsed = parsed * 10 + digit;
	}
	*result = parsed;
	return true;
}

static hud_web_parse_result_t HUD_Web_ParseRequest(const hud_web_client_t *client, hud_web_request_t *request)
{
	const byte *buffer = client->request;
	size_t length = client->request_length;
	const byte *headers_end_pointer;
	const byte *request_line_end_pointer;
	size_t headers_end;
	size_t request_line_end;
	size_t first_space;
	size_t second_space;
	size_t position;
	size_t content_length = 0;
	size_t total_length;
	qbool have_content_length = false;
	qbool have_header_token = false;

	memset(request, 0, sizeof(*request));
	if (length > HUD_WEB_MAX_REQUEST) {
		return HUD_WEB_PARSE_TOO_LARGE;
	}
	headers_end_pointer = HUD_Web_FindBytes(buffer, length, "\r\n\r\n", 4);
	if (!headers_end_pointer) {
		return length == HUD_WEB_MAX_REQUEST ? HUD_WEB_PARSE_TOO_LARGE : HUD_WEB_PARSE_INCOMPLETE;
	}
	headers_end = (size_t)(headers_end_pointer - buffer);
	if (memchr(buffer, '\0', headers_end + 4)) {
		return HUD_WEB_PARSE_BAD;
	}

	request_line_end_pointer = HUD_Web_FindBytes(buffer, headers_end, "\r\n", 2);
	if (!request_line_end_pointer) {
		return HUD_WEB_PARSE_BAD;
	}
	request_line_end = (size_t)(request_line_end_pointer - buffer);
	first_space = 0;
	while (first_space < request_line_end && buffer[first_space] != ' ') {
		++first_space;
	}
	second_space = first_space + 1;
	while (second_space < request_line_end && buffer[second_space] != ' ') {
		++second_space;
	}
	if (!first_space || first_space >= sizeof(request->method) ||
		second_space <= first_space + 1 || second_space >= request_line_end ||
		request_line_end - second_space - 1 != strlen("HTTP/1.1") ||
		memcmp(buffer + second_space + 1, "HTTP/1.1", strlen("HTTP/1.1"))) {
		return HUD_WEB_PARSE_BAD;
	}
	if (second_space - first_space - 1 >= sizeof(request->target) || buffer[first_space + 1] != '/') {
		return HUD_WEB_PARSE_BAD;
	}
	{
		size_t i;
		for (i = 0; i < first_space; ++i) {
			if (buffer[i] < 'A' || buffer[i] > 'Z') {
				return HUD_WEB_PARSE_BAD;
			}
		}
		for (i = first_space + 1; i < second_space; ++i) {
			if (buffer[i] <= 0x20 || buffer[i] >= 0x7f) {
				return HUD_WEB_PARSE_BAD;
			}
		}
	}
	memcpy(request->method, buffer, first_space);
	request->method[first_space] = '\0';
	memcpy(request->target, buffer + first_space + 1, second_space - first_space - 1);
	request->target[second_space - first_space - 1] = '\0';

	position = request_line_end + 2;
	while (position < headers_end) {
		const byte *line_end_pointer = HUD_Web_FindBytes(buffer + position, headers_end + 2 - position, "\r\n", 2);
		size_t line_end;
		size_t colon;
		size_t value_start;
		size_t value_end;
		size_t i;

		if (!line_end_pointer) {
			return HUD_WEB_PARSE_BAD;
		}
		line_end = (size_t)(line_end_pointer - buffer);
		if (line_end == position || buffer[position] == ' ' || buffer[position] == '\t') {
			return HUD_WEB_PARSE_BAD;
		}
		colon = position;
		while (colon < line_end && buffer[colon] != ':') {
			++colon;
		}
		if (colon == position || colon == line_end) {
			return HUD_WEB_PARSE_BAD;
		}
		for (i = position; i < colon; ++i) {
			unsigned char c = buffer[i];
			if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
				(c >= '0' && c <= '9') || c == '-')) {
				return HUD_WEB_PARSE_BAD;
			}
		}
		value_start = colon + 1;
		while (value_start < line_end && (buffer[value_start] == ' ' || buffer[value_start] == '\t')) {
			++value_start;
		}
		value_end = line_end;
		while (value_end > value_start && (buffer[value_end - 1] == ' ' || buffer[value_end - 1] == '\t')) {
			--value_end;
		}

		if (HUD_Web_SpanEqualsInsensitive((const char *)buffer + position, colon - position, "Content-Length")) {
			if (have_content_length || !HUD_Web_ParseContentLength((const char *)buffer + value_start,
					value_end - value_start, &content_length)) {
				return HUD_WEB_PARSE_BAD;
			}
			have_content_length = true;
		}
		else if (HUD_Web_SpanEqualsInsensitive((const char *)buffer + position, colon - position, "Transfer-Encoding")) {
			/* Chunked and all other transfer codings are outside protocol v1. */
			return HUD_WEB_PARSE_BAD;
		}
		else if (HUD_Web_SpanEqualsInsensitive((const char *)buffer + position, colon - position, "X-HUD-Token")) {
			if (have_header_token) {
				return HUD_WEB_PARSE_BAD;
			}
			request->header_token = (const char *)buffer + value_start;
			request->header_token_length = value_end - value_start;
			have_header_token = true;
		}
		position = line_end + 2;
	}

	if (!strcmp(request->method, "POST") && !have_content_length) {
		return HUD_WEB_PARSE_BAD;
	}
	if (strcmp(request->method, "POST") != 0 && content_length != 0) {
		return HUD_WEB_PARSE_BAD;
	}
	if (content_length > HUD_WEB_MAX_REQUEST - (headers_end + 4)) {
		return HUD_WEB_PARSE_TOO_LARGE;
	}
	total_length = headers_end + 4 + content_length;
	if (length < total_length) {
		return HUD_WEB_PARSE_INCOMPLETE;
	}
	if (length != total_length) {
		/* No request pipelining or keep-alive framing. */
		return HUD_WEB_PARSE_BAD;
	}
	request->body = buffer + headers_end + 4;
	request->body_length = content_length;
	return HUD_WEB_PARSE_COMPLETE;
}

static qbool HUD_Web_QueryValue(const char *target, const char *name, const char **value, size_t *value_length)
{
	const char *query = strchr(target, '?');
	size_t name_length = strlen(name);

	if (!query) {
		return false;
	}
	++query;
	while (*query) {
		const char *end = strchr(query, '&');
		const char *equals;
		if (!end) {
			end = query + strlen(query);
		}
		equals = memchr(query, '=', (size_t)(end - query));
		if (equals && (size_t)(equals - query) == name_length && !memcmp(query, name, name_length)) {
			*value = equals + 1;
			*value_length = (size_t)(end - equals - 1);
			return true;
		}
		query = *end ? end + 1 : end;
	}
	return false;
}

static qbool HUD_Web_RequestAuthorized(const hud_web_request_t *request)
{
	const char *query_token;
	size_t query_token_length;

	if (HUD_Web_TokenEquals(request->header_token, request->header_token_length)) {
		return true;
	}
	return HUD_Web_QueryValue(request->target, "t", &query_token, &query_token_length) &&
		HUD_Web_TokenEquals(query_token, query_token_length);
}

static size_t HUD_Web_PathLength(const char *target)
{
	const char *query = strchr(target, '?');
	return query ? (size_t)(query - target) : strlen(target);
}

static qbool HUD_Web_PathEquals(const char *target, const char *path)
{
	size_t target_length = HUD_Web_PathLength(target);
	size_t path_length = strlen(path);
	return target_length == path_length && !memcmp(target, path, path_length);
}

static const char *HUD_Web_StatusReason(int status)
{
	switch (status) {
		case 200: return "OK";
		case 204: return "No Content";
		case 400: return "Bad Request";
		case 403: return "Forbidden";
		case 404: return "Not Found";
		case 503: return "Service Unavailable";
		default: return "Error";
	}
}

static qbool HUD_Web_QueueOwnedResponse(hud_web_client_t *client, int status,
		const char *content_type, byte *body, size_t body_length)
{
	int header_length;

	header_length = snprintf(client->response_header, sizeof(client->response_header),
		"HTTP/1.1 %d %s\r\n"
		"Connection: close\r\n"
		"Content-Length: %llu\r\n"
		"Content-Type: %s\r\n"
		"Access-Control-Allow-Origin: *\r\n"
		"Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
		"Access-Control-Allow-Headers: X-HUD-Token, Content-Type\r\n"
		"Cache-Control: no-store\r\n"
		"\r\n",
		status, HUD_Web_StatusReason(status), (unsigned long long)body_length,
		content_type ? content_type : "application/octet-stream");
	if (header_length < 0 || (size_t)header_length >= sizeof(client->response_header)) {
		if (body) {
			Q_free(body);
		}
		return false;
	}
	client->response_header_length = (size_t)header_length;
	client->response_header_sent = 0;
	client->response_body = body;
	client->response_body_length = body_length;
	client->response_body_sent = 0;
	client->responding = true;
	client->io_time = Sys_DoubleTime();
	return true;
}

static qbool HUD_Web_QueueResponse(hud_web_client_t *client, int status,
		const char *content_type, const void *body, size_t body_length)
{
	byte *owned_body = NULL;

	if (body_length) {
		owned_body = (byte *)Q_malloc(body_length);
		memcpy(owned_body, body, body_length);
	}
	return HUD_Web_QueueOwnedResponse(client, status, content_type, owned_body, body_length);
}

static void HUD_Web_QueueError(hud_web_client_t *client, int status, const char *error)
{
	char json[256];
	int length = snprintf(json, sizeof(json), "{\"ok\":false,\"error\":\"%s\"}", error);

	if (length < 0 || (size_t)length >= sizeof(json) ||
		!HUD_Web_QueueResponse(client, status, "application/json", json, (size_t)length)) {
		HUD_Web_CloseClient(client);
	}
}

/* 503 for the capture rate limit, with the Retry-After the protocol promises. A
 * client that is told to back off but not how long will simply spin. */
static void HUD_Web_QueueRetryAfter(hud_web_client_t *client, int interval_ms)
{
	static const char body[] = "{\"ok\":false,\"error\":\"frame rate limited\"}";
	int seconds = (interval_ms + 999) / 1000;
	int header_length;

	if (seconds < 1) {
		seconds = 1;
	}
	header_length = snprintf(client->response_header, sizeof(client->response_header),
		"HTTP/1.1 503 Service Unavailable\r\n"
		"Connection: close\r\n"
		"Content-Length: %llu\r\n"
		"Content-Type: application/json\r\n"
		"Retry-After: %d\r\n"
		"Access-Control-Allow-Origin: *\r\n"
		"Cache-Control: no-store\r\n"
		"\r\n",
		(unsigned long long)(sizeof(body) - 1), seconds);
	if (header_length < 0 || (size_t)header_length >= sizeof(client->response_header)) {
		HUD_Web_CloseClient(client);
		return;
	}
	client->response_header_length = (size_t)header_length;
	client->response_header_sent = 0;
	client->response_body = (byte *)Q_malloc(sizeof(body) - 1);
	memcpy(client->response_body, body, sizeof(body) - 1);
	client->response_body_length = sizeof(body) - 1;
	client->response_body_sent = 0;
	client->responding = true;
	client->io_time = Sys_DoubleTime();
}

qbool HUD_Web_CommandAllowed(const char *line)
{
	static const char *commands[] = {
		"hud_recalculate", "vid_restart", "cfg_save", "move", "align", "place",
		/* `togglehud` is deliberately NOT here. Despite the name it falls back from
		 * HUD elements to any cvar and toggles it (hud.c:498), so allowing it would
		 * let `togglehud rcon_password` straight past the cvar-prefix policy below.
		 * The editor sets hud_<name>_show directly and needs none of it. */
		/* An editor must be able to clear the console off the view to see the HUD it is
		 * editing. It toggles, so callers read screen.scr_con_current from /state and
		 * only send it when the console is actually down. */
		"toggleconsole",
		/* Font management. `fontload` is preferred over setting font_facepath
		 * because OnChange_font_facepath reads Cmd_Argv(1) rather than the value
		 * it is handed, which makes the `set` form fail silently. */
		"fontload",
		/* Saving. hud_export writes only the HUD cvars; cfg_save (above) writes a
		 * whole config. Both strip any path from their argument and force .cfg,
		 * so neither can be steered outside the configs directory. */
		"hud_export",
		/* Restores placement and visibility to the registered defaults. Added to
		 * the engine for the editor; there was no way to do this before. */
		"hud_reset_layout"
	};
	const char *start;
	const char *end;
	const char *arguments;
	size_t name_length;
	char name[256];
	qbool cvar_prefix;
	int i;

	if (!line || !line[0] || strlen(line) >= 1024 ||
			strchr(line, ';') || strchr(line, '\r') || strchr(line, '\n') ||
			/* Cbuf_ExecuteEx runs Cmd_ExpandString before it dispatches (cmd.c:1865),
			 * which is after this function has already approved the line. So an
			 * approved command can carry a value this check never saw:
			 * `hud_tracking_format $rcon_password` passes the hud_ prefix, expands
			 * into the secret, and /state hands it straight back. Refuse the
			 * expansion character outright -- nothing a HUD editor sets needs it. */
			strchr(line, '$')) {
		return false;
	}
	for (start = line; *start == ' ' || *start == '\t'; ++start) {
	}
	if (!*start) {
		return false;
	}
	end = start;
	while (*end && *end != ' ' && *end != '\t') {
		if ((unsigned char)*end < 0x20 || (unsigned char)*end == 0x7f) {
			return false;
		}
		++end;
	}
	name_length = (size_t)(end - start);
	arguments = end;
	while (*arguments == ' ' || *arguments == '\t') {
		++arguments;
	}

	if (name_length >= sizeof(name)) {
		return false;
	}
	memcpy(name, start, name_length);
	name[name_length] = '\0';

	for (i = 0; i < (int)(sizeof(commands) / sizeof(commands[0])); ++i) {
		if (name_length == strlen(commands[i]) && !memcmp(start, commands[i], name_length)) {
			/* Spelling is not existence. `fontload` is only registered when the
			 * build has EZ_FREETYPE_SUPPORT (fonts.c:526); without it the dispatcher
			 * falls through command and cvar lookup to aliases (cmd.c:1948), so an
			 * allowlisted name the engine does not actually provide would run
			 * whatever alias the user happens to have under it. Requiring a real
			 * command closes that for every entry, not just this one. */
			return Cmd_FindCommand(commands[i]) != NULL;
		}
	}

	if (!*arguments) {
		return false; /* cvar reads are not assignments */
	}
	/* The bridge's own settings are not HUD appearance. Letting a client set them
	 * means it can switch off the capture rate limit, rebind the port (minting a new
	 * token and stranding the editor that asked), or shut the bridge down. */
	if (name_length >= 8 && !memcmp(start, "hud_web", 7) &&
			(name_length == 7 || start[7] == '_')) {
		return false;
	}
	if (name_length == 7 && !memcmp(start, "hud_web", 7)) {
		return false;
	}
	cvar_prefix = (name_length >= 4 && !memcmp(start, "hud_", 4)) ||
		(name_length >= 4 && !memcmp(start, "vid_", 4)) ||
		(name_length >= 4 && !memcmp(start, "scr_", 4)) ||
		(name_length >= 6 && !memcmp(start, "cl_hud", 6)) ||
		/* Font management: the editor owns picking a face and the bake-time
		 * options, so the user never has to know that font_facepath must be set
		 * with the bare form, or that font_capitalize and friends do nothing
		 * until the face is reloaded. */
		(name_length >= 5 && !memcmp(start, "font_", 5)) ||
		(name_length == 14 && !memcmp(start, "gl_consolefont", 14)) ||
		/* cfg_backup defaults to 0, so a plain cfg_save over an existing config
		 * destroys it with nothing kept. The editor turns this on before it
		 * overwrites anything, which is the only reason it is reachable here. */
		(name_length == 10 && !memcmp(start, "cfg_backup", 10)) ||
		/* Which HUD is drawn is not one cvar. scr_newhud and scr_compactHud are
		 * covered by scr_, cl_hud and cl_hudswap by cl_hud, but the classic bar's
		 * shape also depends on these two, and viewsize alone can remove the bar
		 * entirely by driving sb_lines to 0 (cl_screen.c:324). */
		(name_length == 7 && !memcmp(start, "cl_sbar", 7)) ||
		(name_length == 8 && !memcmp(start, "viewsize", 8));
	if (!cvar_prefix) {
		return false;
	}
	/* A prefix alone is not enough: otherwise an alias named hud_* could run. */
	return Cvar_Find(name) != NULL;
}

static char *HUD_Web_DecodeCommand(const byte *body, size_t body_length)
{
	size_t first = 0;
	char *command;

	if (!body_length || memchr(body, '\0', body_length)) {
		return NULL;
	}
	while (first < body_length && (body[first] == ' ' || body[first] == '\t' ||
			body[first] == '\r' || body[first] == '\n')) {
		++first;
	}
	if (first < body_length && body[first] == '{') {
		json_error_t error;
		json_t *root = json_loadb((const char *)body, body_length, JSON_REJECT_DUPLICATES, &error);
		json_t *value;
		const char *string;
		size_t string_length;

		if (!root || !json_is_object(root) || json_object_size(root) != 1) {
			if (root) {
				json_decref(root);
			}
			return NULL;
		}
		value = json_object_get(root, "cmd");
		if (!json_is_string(value)) {
			json_decref(root);
			return NULL;
		}
		string = json_string_value(value);
		string_length = json_string_length(value);
		if (strlen(string) != string_length) {
			json_decref(root);
			return NULL;
		}
		command = (char *)Q_malloc(string_length + 1);
		memcpy(command, string, string_length + 1);
		json_decref(root);
		return command;
	}

	command = (char *)Q_malloc(body_length + 1);
	memcpy(command, body, body_length);
	command[body_length] = '\0';
	return command;
}

static qbool HUD_Web_ParseScale(const char *target, float *scale)
{
	const char *value;
	size_t value_length;
	char buffer[64];
	char *end;
	double parsed;

	*scale = 1.0f;
	if (!HUD_Web_QueryValue(target, "scale", &value, &value_length)) {
		return true;
	}
	if (!value_length || value_length >= sizeof(buffer)) {
		return false;
	}
	memcpy(buffer, value, value_length);
	buffer[value_length] = '\0';
	parsed = strtod(buffer, &end);
	if (*end || !isfinite(parsed) || parsed <= 0.0 || parsed > 1.0) {
		return false;
	}
	*scale = (float)parsed;
	return true;
}

static const unsigned char *HUD_Web_LookupAsset(const char *target,
		const char **content_type, size_t *length)
{
	return HUD_Web_Asset(target, HUD_Web_PathLength(target), content_type, length);
}

static qbool HUD_Web_IsKnownPath(const char *target)
{
	const char *content_type;
	size_t length;

	return HUD_Web_PathEquals(target, "/state") || HUD_Web_PathEquals(target, "/cmd") ||
		HUD_Web_PathEquals(target, "/frame.png") || HUD_Web_PathEquals(target, "/fonts") ||
		HUD_Web_PathEquals(target, "/configs") ||
		HUD_Web_PathEquals(target, "/palette") ||
		HUD_Web_LookupAsset(target, &content_type, &length) != NULL;
}

static void HUD_Web_Route(hud_web_client_t *client, const hud_web_request_t *request)
{
	/* The editor's own files are served without the token, and deliberately.
	 * They are this project's source: byte-identical for every user, carrying
	 * nothing about this one, so gating them protects nothing. It would also not
	 * work -- the browser does not attach our query token to the module and
	 * stylesheet requests the page makes for itself, so a gated /index.html would
	 * load into a page whose scripts all 403. Every route that reads engine state
	 * or drives the console stays behind the token, below. */
	if (!strcmp(request->method, "GET")) {
		const char *content_type;
		size_t asset_length;
		const unsigned char *asset = HUD_Web_LookupAsset(request->target, &content_type, &asset_length);

		if (asset) {
			if (!HUD_Web_QueueResponse(client, 200, content_type, asset, asset_length)) {
				HUD_Web_CloseClient(client);
			}
			return;
		}
	}

	/* Answer "no such route" before "not authorized". A browser asks for
	 * /favicon.ico unprompted, and a 403 for it puts an error in the console of
	 * an editor that is working perfectly. */
	if (!HUD_Web_IsKnownPath(request->target)) {
		HUD_Web_QueueError(client, 404, "not found");
		return;
	}

	if (!HUD_Web_RequestAuthorized(request)) {
		HUD_Web_QueueError(client, 403, "forbidden");
		return;
	}

	if (!strcmp(request->method, "OPTIONS")) {
		if (!HUD_Web_QueueResponse(client, 204, "text/plain", NULL, 0)) {
			HUD_Web_CloseClient(client);
		}
		return;
	}

	if (!strcmp(request->method, "GET") && HUD_Web_PathEquals(request->target, "/state")) {
		size_t length = 0;
		char *json = HUD_Web_StateJSON(&length);
		if (!json) {
			HUD_Web_QueueError(client, 503, "state unavailable");
		}
		else if (!HUD_Web_QueueOwnedResponse(client, 200, "application/json", (byte *)json, length)) {
			HUD_Web_CloseClient(client);
		}
		return;
	}
	if (!strcmp(request->method, "GET") && HUD_Web_PathEquals(request->target, "/fonts")) {
		size_t length = 0;
		char *json = HUD_Web_FontsJSON(&length);
		if (!json) {
			HUD_Web_QueueError(client, 503, "font list unavailable");
		}
		else if (!HUD_Web_QueueOwnedResponse(client, 200, "application/json", (byte *)json, length)) {
			HUD_Web_CloseClient(client);
		}
		return;
	}
	if (!strcmp(request->method, "GET") && HUD_Web_PathEquals(request->target, "/palette")) {
		size_t length = 0;
		char *json = HUD_Web_PaletteJSON(&length);
		if (!json) {
			HUD_Web_QueueError(client, 503, "palette unavailable");
		}
		else if (!HUD_Web_QueueOwnedResponse(client, 200, "application/json", (byte *)json, length)) {
			HUD_Web_CloseClient(client);
		}
		return;
	}
	if (!strcmp(request->method, "GET") && HUD_Web_PathEquals(request->target, "/configs")) {
		size_t length = 0;
		char *json = HUD_Web_ConfigsJSON(&length);
		if (!json) {
			HUD_Web_QueueError(client, 503, "config list unavailable");
		}
		else if (!HUD_Web_QueueOwnedResponse(client, 200, "application/json", (byte *)json, length)) {
			HUD_Web_CloseClient(client);
		}
		return;
	}
	if (!strcmp(request->method, "GET") && HUD_Web_PathEquals(request->target, "/frame.png")) {
		float scale;
		size_t length = 0;
		byte *png;

		static double last_capture = 0;
		int interval = max(0, hud_web_frame_interval.integer);
		double now = Sys_DoubleTime() * 1000.0;

		if (!HUD_Web_ParseScale(request->target, &scale)) {
			HUD_Web_QueueError(client, 400, "invalid scale");
			return;
		}
		/* Shared across clients on purpose: the cost is the engine's, not each
		 * client's, so the budget has to be the engine's too. */
		if (last_capture != 0 && now - last_capture < interval) {
			HUD_Web_QueueRetryAfter(client, interval);
			return;
		}
		last_capture = now;
		png = HUD_Web_CapturePNG(scale, &length);
		if (!png) {
			HUD_Web_QueueError(client, 503, "frame unavailable");
		}
		else if (!HUD_Web_QueueOwnedResponse(client, 200, "image/png", png, length)) {
			HUD_Web_CloseClient(client);
		}
		return;
	}
	if (!strcmp(request->method, "POST") && HUD_Web_PathEquals(request->target, "/cmd")) {
		char *command = HUD_Web_DecodeCommand(request->body, request->body_length);
		if (!command) {
			HUD_Web_QueueError(client, 400, "malformed command");
			return;
		}
		if (!HUD_Web_CommandAllowed(command)) {
			Q_free(command);
			HUD_Web_QueueError(client, 403, "command not permitted");
			return;
		}
		Cbuf_AddText(command);
		Cbuf_AddText("\n");
		Q_free(command);
		if (!HUD_Web_QueueResponse(client, 200, "application/json", "{\"ok\":true}", 11)) {
			HUD_Web_CloseClient(client);
		}
		return;
	}

	/* The path exists -- checked above -- so this is the wrong method for it. */
	HUD_Web_QueueError(client, 400, "method not supported");
}

static qbool HUD_Web_SendPart(hud_web_client_t *client, const byte *data, size_t length, size_t *sent)
{
	size_t remaining = length - *sent;
	int amount;
	int result;

	if (!remaining) {
		return true;
	}
	amount = (int)min(remaining, (size_t)HUD_WEB_SEND_CHUNK);
	result = send(client->socket, (const char *)data + *sent, amount, HUD_WEB_SEND_FLAGS);
	if (result > 0) {
		*sent += (size_t)result;
		client->io_time = Sys_DoubleTime();
		return true;
	}
	if (result < 0 && HUD_Web_IsWouldBlock(qerrno)) {
		return true;
	}
	return false;
}

static void HUD_Web_SendResponse(hud_web_client_t *client)
{
	if (!HUD_Web_SendPart(client, (const byte *)client->response_header,
			client->response_header_length, &client->response_header_sent)) {
		HUD_Web_CloseClient(client);
		return;
	}
	if (client->response_header_sent < client->response_header_length) {
		return;
	}
	if (client->response_body_length &&
		!HUD_Web_SendPart(client, client->response_body, client->response_body_length,
			&client->response_body_sent)) {
		HUD_Web_CloseClient(client);
		return;
	}
	if (client->response_body_sent == client->response_body_length) {
		HUD_Web_CloseClient(client);
	}
}

static void HUD_Web_ServiceClient(hud_web_client_t *client, double now)
{
	hud_web_request_t request;
	hud_web_parse_result_t parsed;
	int received;

	/* Idle OR simply taking too long. A client that keeps dribbling bytes resets
	 * io_time forever, which is how four of them could hold every slot and lock the
	 * editor out indefinitely. Age is measured from accept and nothing resets it. */
	if (now - client->io_time > HUD_WEB_CLIENT_TIMEOUT ||
			(!client->responding && now - client->accept_time > HUD_WEB_REQUEST_MAX_AGE)) {
		HUD_Web_CloseClient(client);
		return;
	}
	if (client->responding) {
		HUD_Web_SendResponse(client);
		return;
	}

	if (client->request_length == HUD_WEB_MAX_REQUEST) {
		HUD_Web_QueueError(client, 400, "request too large");
		HUD_Web_SendResponse(client);
		return;
	}
	received = recv(client->socket, (char *)client->request + client->request_length,
		(int)(HUD_WEB_MAX_REQUEST - client->request_length), 0);
	if (received == 0) {
		HUD_Web_CloseClient(client);
		return;
	}
	if (received < 0) {
		if (!HUD_Web_IsWouldBlock(qerrno)) {
			HUD_Web_CloseClient(client);
		}
		return;
	}
	client->request_length += (size_t)received;
	client->request[client->request_length] = '\0';
	client->io_time = now;

	parsed = HUD_Web_ParseRequest(client, &request);
	if (parsed == HUD_WEB_PARSE_INCOMPLETE) {
		return;
	}
	if (parsed == HUD_WEB_PARSE_TOO_LARGE) {
		HUD_Web_QueueError(client, 400, "request too large");
	}
	else if (parsed == HUD_WEB_PARSE_BAD) {
		HUD_Web_QueueError(client, 400, "malformed request");
	}
	else {
		HUD_Web_Route(client, &request);
	}
	if (client->socket != INVALID_SOCKET && client->responding) {
		/* Small responses normally complete in the request frame. */
		HUD_Web_SendResponse(client);
	}
}

static hud_web_client_t *HUD_Web_FreeClient(void)
{
	int i;
	for (i = 0; i < HUD_WEB_MAX_CLIENTS; ++i) {
		if (hud_web_clients[i].socket == INVALID_SOCKET) {
			return &hud_web_clients[i];
		}
	}
	return NULL;
}

static void HUD_Web_RejectExcessClient(socket_t socket)
{
	/* No fifth request is admitted: without a slot we cannot parse and authenticate it. */
	closesocket(socket);
}

static void HUD_Web_AcceptClients(double now)
{
	int accepted;

	for (accepted = 0; accepted < HUD_WEB_ACCEPTS_PER_FRAME; ++accepted) {
		struct sockaddr_in peer;
		socklen_t peer_length = sizeof(peer);
		socket_t socket = accept(hud_web_listener, (struct sockaddr *)&peer, &peer_length);
		hud_web_client_t *client;

		if (socket == INVALID_SOCKET) {
			if (!HUD_Web_IsWouldBlock(qerrno)) {
				Com_DPrintf("HUD bridge: accept failed (%d)\n", qerrno);
			}
			break;
		}
		if (!HUD_Web_SetNonBlocking(socket)) {
			closesocket(socket);
			continue;
		}
		client = HUD_Web_FreeClient();
		if (!client) {
			HUD_Web_RejectExcessClient(socket);
			continue;
		}
		memset(client, 0, sizeof(*client));
		client->socket = socket;
		client->io_time = now;
		client->accept_time = now;
	}
}

void HUD_Web_Init(void)
{
	int i;

	if (hud_web_initialized) {
		return;
	}
	for (i = 0; i < HUD_WEB_MAX_CLIENTS; ++i) {
		hud_web_clients[i].socket = INVALID_SOCKET;
	}
	Cvar_SetCurrentGroup(CVAR_GROUP_NETWORK);
	Cvar_Register(&hud_web);
	Cvar_Register(&hud_web_port);
	Cvar_Register(&hud_web_frame_interval);
	Cvar_ResetCurrentGroup();
	hud_web_initialized = true;
}

void HUD_Web_Shutdown(void)
{
	if (!hud_web_initialized) {
		return;
	}
	HUD_Web_Stop(false);
	hud_web_initialized = false;
}

void HUD_Web_Frame(void)
{
	int port;
	int i;
	double now;

	if (!hud_web_initialized) {
		return;
	}
	if (!hud_web.integer) {
		HUD_Web_Stop(true);
		hud_web_retry_port = 0;
		hud_web_retry_after = 0;
		return;
	}

	port = hud_web_port.integer;
	now = Sys_DoubleTime();
	if (port < 1 || port > 65535) {
		if (hud_web_retry_port != port) {
			Com_Printf("HUD bridge: hud_web_port must be between 1 and 65535\n");
		}
		HUD_Web_Stop(false);
		hud_web_retry_port = port;
		return;
	}
	if (hud_web_listener != INVALID_SOCKET && hud_web_bound_port != port) {
		HUD_Web_Stop(false);
	}
	if (hud_web_retry_port != port) {
		hud_web_retry_port = port;
		hud_web_retry_after = 0;
	}
	if (hud_web_listener == INVALID_SOCKET) {
		if (now < hud_web_retry_after) {
			return;
		}
		if (!HUD_Web_Start(port)) {
			hud_web_retry_after = now + 1.0;
			return;
		}
	}

	HUD_Web_AcceptClients(now);
	for (i = 0; i < HUD_WEB_MAX_CLIENTS; ++i) {
		if (hud_web_clients[i].socket != INVALID_SOCKET) {
			HUD_Web_ServiceClient(&hud_web_clients[i], now);
		}
	}
}
