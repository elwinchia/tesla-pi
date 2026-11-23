# Headless offline renderer for engine-sim (github.com/ange-yaghi/engine-sim,
# MIT). Builds the simulation core, its script compiler (piranha) and the
# constraint solver from the upstream sources, patched for clang by
# make-tree.sh; leaves out the Windows-only UI (delta-studio). Use build.sh.
#   cmake -S scripts/engine-sim -B <build> -DES_TREE=<patched tree> -DES_SHIM=<dir with FlexLexer.h>
cmake_minimum_required(VERSION 3.16)
project(es_headless CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_BUILD_TYPE Release)
# MSVC keywords the upstream code uses, mapped for clang.
add_compile_definitions("__forceinline=inline" "__int64=long long")
# MSVC accepts templates that use a type before it is defined; clang does
# with this flag. And macOS has no malloc.h (shim/malloc.h).
add_compile_options(-fdelayed-template-parsing -Wno-deprecated-declarations)
# shim/: malloc.h for macOS; ES_SHIM: FlexLexer.h matching the system flex.
include_directories(BEFORE ${CMAKE_CURRENT_SOURCE_DIR}/shim ${ES_SHIM})
# ES_TREE: a copy of upstream with make-tree.sh's patches.
set(ES ${ES_TREE})
if (NOT ES_TREE OR NOT EXISTS ${ES_TREE}/src)
    message(FATAL_ERROR "set -DES_TREE to the tree make-tree.sh made")
endif ()
set(SUB ${ES}/dependencies/submodules)

find_package(FLEX REQUIRED)
find_package(BISON 3.0 REQUIRED)
find_package(Boost REQUIRED COMPONENTS filesystem)

flex_target(lexer ${SUB}/piranha/flex-bison/scanner.l ${CMAKE_CURRENT_BINARY_DIR}/scanner.auto.cpp
    DEFINES_FILE ${CMAKE_CURRENT_BINARY_DIR}/scanner.auto.h)
bison_target(parser ${SUB}/piranha/flex-bison/specification.y ${CMAKE_CURRENT_BINARY_DIR}/parser.auto.cpp
    DEFINES_FILE ${CMAKE_CURRENT_BINARY_DIR}/parser.auto.h)
add_flex_bison_dependency(lexer parser)

file(GLOB PIRANHA_SRC ${SUB}/piranha/src/*.cpp)
add_library(piranha STATIC ${PIRANHA_SRC} ${BISON_parser_OUTPUTS} ${FLEX_lexer_OUTPUTS})
# FlexLexer.h comes from shim/ (the copy matching the system flex), not the
# Windows flex copy bundled with piranha.
target_include_directories(piranha PUBLIC ${CMAKE_CURRENT_BINARY_DIR} ${SUB}/piranha/include)
target_link_libraries(piranha Boost::filesystem)

file(GLOB SCS_SRC ${SUB}/simple-2d-constraint-solver/src/*.cpp)
add_library(scs STATIC ${SCS_SRC})

add_library(csvio STATIC ${SUB}/csv-io/src/csv_data.cpp ${SUB}/csv-io/src/information.cpp)

add_library(es_core STATIC
    ${ES}/src/audio_buffer.cpp
    ${ES}/src/camshaft.cpp
    ${ES}/src/crankshaft.cpp
    ${ES}/src/combustion_chamber.cpp
    ${ES}/src/connecting_rod.cpp
    ${ES}/src/convolution_filter.cpp
    ${ES}/src/cylinder_bank.cpp
    ${ES}/src/cylinder_head.cpp
    ${ES}/src/delay_filter.cpp
    ${ES}/src/derivative_filter.cpp
    ${ES}/src/direct_throttle_linkage.cpp
    ${ES}/src/dynamometer.cpp
    ${ES}/src/engine.cpp
    ${ES}/src/exhaust_system.cpp
    ${ES}/src/feedback_comb_filter.cpp
    ${ES}/src/filter.cpp
    ${ES}/src/fuel.cpp
    ${ES}/src/function.cpp
    ${ES}/src/gas_system.cpp
    ${ES}/src/gaussian_filter.cpp
    ${ES}/src/governor.cpp
    ${ES}/src/ignition_module.cpp
    ${ES}/src/impulse_response.cpp
    ${ES}/src/intake.cpp
    ${ES}/src/jitter_filter.cpp
    ${ES}/src/leveling_filter.cpp
    ${ES}/src/low_pass_filter.cpp
    ${ES}/src/part.cpp
    ${ES}/src/piston.cpp
    ${ES}/src/piston_engine_simulator.cpp
    ${ES}/src/simulator.cpp
    ${ES}/src/standard_valvetrain.cpp
    ${ES}/src/starter_motor.cpp
    ${ES}/src/throttle.cpp
    ${ES}/src/transmission.cpp
    ${ES}/src/utilities.cpp
    ${ES}/src/valvetrain.cpp
    ${ES}/src/vehicle.cpp
    ${ES}/src/vehicle_drag_constraint.cpp
    ${ES}/src/vtec_valvetrain.cpp
    ${ES}/src/synthesizer.cpp)
target_include_directories(es_core PUBLIC ${SUB})
target_link_libraries(es_core scs csvio)

file(GLOB SCRIPT_SRC ${ES}/scripting/src/*.cpp)
add_library(es_script STATIC ${SCRIPT_SRC})
target_include_directories(es_script PUBLIC ${SUB})
target_compile_definitions(es_script PUBLIC ATG_ENGINE_SIM_PIRANHA_ENABLED)
target_link_libraries(es_script es_core piranha csvio)

add_executable(es-render render.cpp)
target_include_directories(es-render PRIVATE ${ES})
target_compile_definitions(es-render PUBLIC ATG_ENGINE_SIM_PIRANHA_ENABLED)
target_link_libraries(es-render es_script es_core)
